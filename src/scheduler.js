import cron from 'node-cron';
import {
  listAgents, setNextCycle, touchLastCycle, getAgent, agentState, setAgentState, db,
  twitterEnabled, setTwitterEnabled, setNextTweet, touchLastTweet, getNextUntweetedPost,
  recordTweetResult,
} from './db.js';
import { runCycle } from './pipeline.js';
import { postTweet, composeTweet, isDryRun } from './twitter.js';

const HOUR = 3_600_000;

/** Autonomous loop runs for this long after an agent is initialized. */
export const AUTONOMY_HOURS = Number(process.env.AUTONOMY_HOURS || 48);

const MIN_INTERVAL_H = Number(process.env.CYCLE_MIN_HOURS || 2);
const MAX_INTERVAL_H = Number(process.env.CYCLE_MAX_HOURS || 3);

/**
 * Quota-aware pacing.
 *
 * Every additional agent multiplies daily API usage, and a free-tier daily cap is a hard
 * wall: once it is hit every agent stops publishing until midnight Pacific, which is
 * exactly the failure the 48-hour autonomy requirement cannot survive. So the cadence
 * stretches with the size of the roster instead of staying fixed and quietly running out.
 *
 * One agent is unaffected — the derived interval lands below the 2h floor, so the normal
 * 2-3h cadence applies. Six agents stretch to roughly 5h apart, which keeps the whole
 * roster inside the budget for a full day.
 *
 * Set CYCLE_DAILY_CALL_BUDGET=0 to disable and use the fixed interval regardless.
 *
 * The default is deliberately small. Gemini's free tier caps
 * `GenerateRequestsPerDayPerProjectPerModel` at 20 requests per day per model — measured
 * on the key this was built against, and an order of magnitude below what a first estimate
 * would suggest. The budget below assumes roughly six usable models in the fallback chain,
 * each contributing its own daily allowance. Raise it on a paid key, where this whole
 * mechanism stops mattering.
 */
const DAILY_CALL_BUDGET = Number(process.env.CYCLE_DAILY_CALL_BUDGET ?? 100);

/** Discovery + one judging call per candidate (3-4) + a write call or two. */
const CALLS_PER_CYCLE = Number(process.env.CYCLE_CALLS_ESTIMATE || 6);

/** Agents still inside their autonomy window — expired ones cost nothing. */
function activeAgentCount() {
  const now = Date.now();
  return Math.max(1, listAgents().filter((a) => now < new Date(a.expires_at).getTime()).length);
}

/** Random gap, floored at whatever the daily call budget can actually sustain. */
function nextInterval() {
  const base = MIN_INTERVAL_H + Math.random() * (MAX_INTERVAL_H - MIN_INTERVAL_H);

  if (!DAILY_CALL_BUDGET) return base * HOUR;

  const agents = activeAgentCount();
  const quotaFloorH = (24 * agents * CALLS_PER_CYCLE) / DAILY_CALL_BUDGET;

  // Keep the randomised spread when the quota floor binds, so agents don't sync up.
  const spread = MAX_INTERVAL_H - MIN_INTERVAL_H;
  const hours = Math.max(base, quotaFloorH + Math.random() * spread);
  return hours * HOUR;
}

/** Reported by /api/agent/status so the pacing in effect is visible, not guessed at. */
export function cadenceDescription() {
  if (!DAILY_CALL_BUDGET) return `${MIN_INTERVAL_H}-${MAX_INTERVAL_H} hours`;
  const agents = activeAgentCount();
  const quotaFloorH = (24 * agents * CALLS_PER_CYCLE) / DAILY_CALL_BUDGET;
  if (quotaFloorH <= MIN_INTERVAL_H) return `${MIN_INTERVAL_H}-${MAX_INTERVAL_H} hours`;
  const lo = quotaFloorH.toFixed(1);
  const hi = (quotaFloorH + (MAX_INTERVAL_H - MIN_INTERVAL_H)).toFixed(1);
  return `${lo}-${hi} hours (stretched from ${MIN_INTERVAL_H}-${MAX_INTERVAL_H}h to keep ${agents} agents inside a ${DAILY_CALL_BUDGET}-call daily budget)`;
}

/** How soon to retry after a transient failure, rather than losing the whole slot. */
const RETRY_DELAY_MS = Number(process.env.CYCLE_RETRY_MINUTES || 10) * 60_000;

/* ------------------------------- tweet cadence -------------------------------- */

/**
 * Tweeting runs on its own schedule, independent of the discover/judge/write cycle.
 *
 * Decoupling matters for two reasons. First, a cycle that publishes two posts should not
 * tweet both back to back — that reads as spam on a timeline in a way it does not in a
 * scrolling feed. Second, "post a tweet every so often" and "write a new post every so
 * often" are different cadences the operator may want to tune separately: someone might want
 * five posts written per day but only two tweeted.
 */
const TWEET_MIN_H = Number(process.env.TWEET_MIN_HOURS || 3);
const TWEET_MAX_H = Number(process.env.TWEET_MAX_HOURS || 5);

/** No published post waiting yet — check again soon rather than waiting a full interval. */
const TWEET_WAIT_FOR_CONTENT_MS = Number(process.env.TWEET_WAIT_MINUTES || 20) * 60_000;

/** Backoff after an account-level failure (auth, rate limit) that no specific post caused. */
const TWEET_RETRY_MS = Number(process.env.TWEET_RETRY_MINUTES || 15) * 60_000;

function nextTweetInterval() {
  return (TWEET_MIN_H + Math.random() * (TWEET_MAX_H - TWEET_MIN_H)) * HOUR;
}

export function scheduleNextTweet(agentId, fromMs = Date.now(), delayMs = nextTweetInterval()) {
  const next = new Date(fromMs + delayMs).toISOString();
  setNextTweet(agentId, next);
  return next;
}

export const tweetCadenceDescription = () => `${TWEET_MIN_H}-${TWEET_MAX_H} hours`;

export function scheduleNext(agentId, fromMs = Date.now()) {
  const next = new Date(fromMs + nextInterval()).toISOString();
  setNextCycle(agentId, next);
  return next;
}

/** In-flight guard so a slow cycle can't overlap itself or race the trigger endpoint. */
const running = new Set();

/** Same purpose as `running`, kept separate: a cycle and a tweet attempt for the same agent
 *  can legitimately overlap — writing and promoting are independent operations. */
const tweeting = new Set();
export const isTweeting = (agentId) => tweeting.has(agentId);

/** Manual "tweet now", parallel to runCycleGuarded — used by the API and for testing. */
export async function tweetNowGuarded(agentId) {
  if (tweeting.has(agentId)) return { tweeted: false, reason: 'tweet-already-in-flight' };
  tweeting.add(agentId);
  try {
    return await tweetOne(agentId);
  } finally {
    tweeting.delete(agentId);
  }
}

export async function runCycleGuarded(agentId, trigger) {
  if (running.has(agentId)) {
    return { skipped: true, reason: 'cycle-already-running' };
  }
  running.add(agentId);
  try {
    const result = await runCycle(agentId, { trigger });
    touchLastCycle(agentId); // stamped on real completion, whatever fired it
    return result;
  } finally {
    running.delete(agentId);
  }
}

export const isRunning = (agentId) => running.has(agentId);

/** Gap between the priming cycles of agents initialized back to back. */
const PRIME_STAGGER_MS = Number(process.env.PRIME_STAGGER_MINUTES || 3) * 60_000;

/**
 * First cycle fires shortly after init rather than a full interval later, so a freshly
 * initialized agent has something in its feed. Subsequent cycles use the real cadence.
 * Fire-and-forget: /api/agent/init must not block on the LLM.
 *
 * The delay grows with the number of agents already registered. Seeding a whole roster in
 * one go otherwise fires every priming cycle at the same moment, and they collide head-on
 * with the per-minute rate limit — observed the first time six agents were seeded together,
 * where every one of them failed discovery. Staggering costs a few minutes on first run and
 * makes the difference between a roster that starts cleanly and one that starts by
 * rate-limiting itself.
 */
export function primeFirstCycle(agentId, delayMs = 12_000) {
  scheduleNext(agentId); // real cadence is set immediately, independent of this priming run

  // This agent is already in the table, so position 1 keeps the original short delay.
  const position = Math.max(0, activeAgentCount() - 1);
  const wait = delayMs + position * PRIME_STAGGER_MS;

  if (position > 0) {
    console.log(`[scheduler] priming ${agentId} in ${Math.round(wait / 60_000)}min (position ${position + 1} in the roster)`);
  }

  setTimeout(() => {
    runCycleGuarded(agentId, 'init').catch((e) => console.error('[init-cycle]', e.message));
  }, wait).unref?.();
}

/**
 * The autonomous heartbeat.
 *
 * Ticks every 5 minutes and runs any agent whose next_cycle_at has passed. Using a
 * frequent tick with a stored due-time (rather than one cron expression per agent)
 * means a missed window is detected and caught up on the next tick — important on
 * Render's free tier, where an idle instance can be spun down and later revived.
 */
export function startScheduler() {
  const task = cron.schedule('*/5 * * * *', tick, { scheduled: true });
  console.log(
    `[scheduler] started — tick every 5min, cadence ${cadenceDescription()}, autonomy window ${AUTONOMY_HOURS}h, ` +
      `tweet cadence ${tweetCadenceDescription()}${isDryRun() ? ' (DRY RUN)' : ''}`
  );
  // Catch up immediately on boot for anything already overdue.
  setTimeout(tick, 5_000).unref?.();
  return task;
}

async function tick() {
  const now = Date.now();
  for (const agent of listAgents()) {
    // Manual control wins over the schedule. Checked on every tick rather than cached, so
    // pausing takes effect at the next tick without needing to reach into the scheduler.
    const active = agentState(agent) === 'active';
    const withinWindow = now < new Date(agent.expires_at).getTime();

    if (active && withinWindow) {
      const due = agent.next_cycle_at ? new Date(agent.next_cycle_at).getTime() : 0;
      if (now >= due) {
        // Reschedule before running so a failure can't wedge the agent into a retry loop.
        scheduleNext(agent.id, now);
        try {
          await runCycleGuarded(agent.id, 'cron');
        } catch (err) {
          // A failed cycle is survivable by design: the loop keeps ticking either way.
          // Transient causes (rate limit, network, a truncated response) get a short retry
          // instead of forfeiting the slot; anything else waits for the normal cadence.
          console.error(`[scheduler] cycle failed for ${agent.id} (${err.code || 'ERR'}):`, err.message);
          if (err.retryable) {
            const retryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
            setNextCycle(agent.id, retryAt);
            console.log(`[scheduler] retrying ${agent.id} at ${retryAt}`);
          }
        }
      }
    }

    // Tweeting has its own on/off switch and its own due-time, checked independently of the
    // write cycle above — an agent can be actively writing but have tweeting paused, or the
    // reverse would be pointless (nothing to tweet) but is not specifically guarded against.
    if (active && withinWindow && twitterEnabled(agent) && !tweeting.has(agent.id)) {
      const tweetDue = agent.next_tweet_at ? new Date(agent.next_tweet_at).getTime() : 0;
      if (now >= tweetDue) {
        tweeting.add(agent.id);
        try {
          await tweetOne(agent.id);
        } finally {
          tweeting.delete(agent.id);
        }
      }
    }
  }
}

/**
 * Render's free tier sleeps a service after ~15 min without inbound traffic, which
 * would stop the cron timer. A light self-ping keeps the instance warm so the
 * autonomous loop actually survives the full 48h. No-op when not on Render.
 */
export function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return null;
  const id = setInterval(() => {
    fetch(`${url}/api/health`).catch(() => {});
  }, 12 * 60 * 1000);
  id.unref?.();
  console.log(`[keepalive] self-ping every 12min -> ${url}/api/health`);
  return id;
}

/**
 * Pause, resume, or stop an agent.
 *
 * Resuming reschedules from now when the stored due time has already passed. Without that, an
 * agent paused for six hours would fire the moment it resumed — which reads as the pause
 * having been ignored. A due time still in the future is left alone, so a brief pause does
 * not push the schedule back.
 *
 * A cycle already in flight is not aborted: it holds an open request to the model provider,
 * and killing it would spend the quota without storing the post. It finishes and writes its
 * result; the pause takes effect from the next tick.
 */
export function setLifecycle(agentId, state) {
  const agent = setAgentState(agentId, state);

  if (state === 'active') {
    const due = agent.next_cycle_at ? new Date(agent.next_cycle_at).getTime() : 0;
    if (due <= Date.now()) scheduleNext(agentId);
  }

  console.log(`[scheduler] agent ${agentId} -> ${state}${running.has(agentId) ? ' (a cycle is mid-flight and will finish)' : ''}`);
  return getAgent(agentId);
}

/**
 * Turn tweeting on or off for an agent. Decoupled from `setLifecycle` deliberately — pausing
 * or stopping the write cycle and enabling/disabling tweeting are independent switches, since
 * an operator might want the agent to keep writing while its tweets are paused, or vice versa
 * (though tweeting with nothing new to promote just idles until a post exists).
 */
export function setTweeting(agentId, enabled) {
  const agent = setTwitterEnabled(agentId, enabled);
  if (enabled) {
    // Check soon rather than waiting a full interval, so enabling it on an agent that
    // already has an unpromoted post tweets it promptly instead of hours later.
    scheduleNextTweet(agentId, Date.now(), 60_000);
  } else {
    setNextTweet(agentId, null);
  }
  console.log(`[scheduler] agent ${agentId} tweeting -> ${enabled ? 'enabled' : 'disabled'}`);
  return agent;
}

/**
 * One tweet attempt for one agent.
 *
 * The distinction that matters here is *who* a failure belongs to. A rejection tied to this
 * specific post (X refuses it as duplicate content, for instance) should not be retried
 * against the same post forever, so it is recorded and the queue moves on. A rejection tied
 * to the account (bad credentials, a billing gate, a rate limit) has nothing to do with which
 * post was chosen, so the post is left untouched and eligible, and only the account-level
 * retry timer backs off.
 */
async function tweetOne(agentId) {
  const post = getNextUntweetedPost(agentId);
  if (!post) {
    scheduleNextTweet(agentId, Date.now(), TWEET_WAIT_FOR_CONTENT_MS);
    return { tweeted: false, reason: 'nothing-to-tweet' };
  }

  const text = composeTweet({ takeaway: post.takeaway, text: post.text, sources: JSON.parse(post.sources || '[]') });

  try {
    const result = await postTweet({ text, imageUrl: post.image_url });
    recordTweetResult(post.id, {
      tweetId: result.id,
      tweetUrl: result.url,
      tweetText: result.text,
      dryRun: result.dryRun,
    });
    touchLastTweet(agentId);
    scheduleNextTweet(agentId);
    console.log(
      `[twitter] ${result.dryRun ? '[dry-run] ' : ''}tweeted post ${post.id} for agent ${agentId}` +
        (result.url ? ` -> ${result.url}` : '')
    );
    return { tweeted: true, dryRun: result.dryRun, postId: post.id };
  } catch (err) {
    const postSpecific = err.code === 'FORBIDDEN';
    if (postSpecific) {
      recordTweetResult(post.id, { tweetText: text, dryRun: isDryRun(), error: err.message });
      scheduleNextTweet(agentId);
    } else {
      // Account-level: leave the post untouched so it is retried once the underlying cause
      // (auth, billing, rate limit) clears, rather than burning through the whole queue
      // marking every post as failed for a problem none of them caused.
      scheduleNextTweet(agentId, Date.now(), err.retryAfter ? err.retryAfter * 1000 + 1000 : TWEET_RETRY_MS);
    }
    console.error(`[twitter] failed for agent ${agentId} (${err.code || 'ERR'}): ${err.message}`);
    return { tweeted: false, reason: err.code || 'ERROR', error: err.message };
  }
}

export function schedulerInfo(agentId) {
  const a = getAgent(agentId);
  if (!a) return null;
  const now = Date.now();
  const expires = new Date(a.expires_at).getTime();
  const state = agentState(a);
  const windowOpen = now < expires;

  return {
    state,
    stateChangedAt: a.state_changed_at || null,
    // Only an active agent inside its window has a meaningful next cycle. Reporting a stale
    // timestamp for a paused agent would have the UI count down to something that will not
    // happen.
    nextCycleAt: state === 'active' && windowOpen ? a.next_cycle_at : null,
    lastCycleAt: a.last_cycle_at,
    autonomyExpiresAt: a.expires_at,
    autonomyActive: state === 'active' && windowOpen,
    cycleCadence: cadenceDescription(),
    isRunningNow: running.has(a.id),
    twitter: {
      enabled: twitterEnabled(a),
      nextTweetAt: twitterEnabled(a) && state === 'active' && windowOpen ? a.next_tweet_at : null,
      lastTweetAt: a.last_tweet_at,
      cadence: tweetCadenceDescription(),
      isTweetingNow: tweeting.has(a.id),
    },
  };
}

export { db };
