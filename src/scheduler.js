import cron from 'node-cron';
import {
  listAgents, setNextCycle, touchLastCycle, getAgent, agentState, setAgentState, db,
  twitterEnabled, setTwitterEnabled, setNextTweet, touchLastTweet, getNextUntweetedPost, recordTweetResult,
  blueskyEnabled, setBlueskyEnabled, setNextSkeet, touchLastSkeet, getNextUnskeetedPost, recordSkeetResult,
} from './db.js';
import { runCycle } from './pipeline.js';
import { postTweet, composeTweet, isDryRun as twitterDryRun } from './twitter.js';
import { postSkeet, composeSkeet, isDryRun as blueskyDryRun } from './bluesky.js';

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

export function scheduleNext(agentId, fromMs = Date.now()) {
  const next = new Date(fromMs + nextInterval()).toISOString();
  setNextCycle(agentId, next);
  return next;
}

/** In-flight guard so a slow cycle can't overlap itself or race the trigger endpoint. */
const running = new Set();

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

/* ------------------------------ social posting -------------------------------- */

/**
 * X and Bluesky promotion share one scheduling shape: their own cadence, independent of the
 * discover/judge/write cycle (a cycle that publishes two posts should not promote both back
 * to back — that reads as spam on a timeline in a way it does not in a scrolling feed),
 * always promoting the oldest un-posted post, and the same distinction in failure handling —
 * a rejection tied to a specific post is recorded and the queue moves on, a rejection tied to
 * the account is left untouched and only backs off the retry timer.
 *
 * One factory builds both schedulers from their network-specific pieces (env var prefix, DB
 * ops, the post/compose functions), so this logic — the part that is actually subtle — is
 * written and tested once. Adding a third network is supplying its config, not re-deriving
 * this.
 */
function makeSocialScheduler({
  network, envPrefix, defaultMinH, defaultMaxH, defaultWaitMin, defaultRetryMin,
  isEnabled, setEnabled, setNext, touchLast, getNextUnposted, recordResult,
  post, compose, dryRun,
}) {
  const minH = Number(process.env[`${envPrefix}_MIN_HOURS`] || defaultMinH);
  const maxH = Number(process.env[`${envPrefix}_MAX_HOURS`] || defaultMaxH);
  const waitMs = Number(process.env[`${envPrefix}_WAIT_MINUTES`] || defaultWaitMin) * 60_000;
  const retryMs = Number(process.env[`${envPrefix}_RETRY_MINUTES`] || defaultRetryMin) * 60_000;

  const posting = new Set();

  const nextInterval = () => (minH + Math.random() * (maxH - minH)) * HOUR;
  const cadence = () => `${minH}-${maxH} hours`;

  function scheduleNextPost(agentId, fromMs = Date.now(), delayMs = nextInterval()) {
    const next = new Date(fromMs + delayMs).toISOString();
    setNext(agentId, next);
    return next;
  }

  /** Turn promotion on or off. Independent of write-cycle pause/resume/stop by design. */
  function setPosting(agentId, enabled) {
    const agent = setEnabled(agentId, enabled);
    if (enabled) {
      // Check soon rather than a full interval, so an agent with an already-unpromoted post
      // posts it promptly instead of hours later.
      scheduleNextPost(agentId, Date.now(), 60_000);
    } else {
      setNext(agentId, null);
    }
    console.log(`[scheduler] agent ${agentId} ${network} -> ${enabled ? 'enabled' : 'disabled'}`);
    return agent;
  }

  async function postOne(agentId) {
    const item = getNextUnposted(agentId);
    if (!item) {
      scheduleNextPost(agentId, Date.now(), waitMs);
      return { tweeted: false, posted: false, reason: 'nothing-to-tweet' };
    }

    const text = compose({ takeaway: item.takeaway, text: item.text, sources: JSON.parse(item.sources || '[]') });

    try {
      const result = await post({ text, imageUrl: item.image_url });
      recordResult(item.id, { id: result.id, url: result.url, text: result.text, dryRun: result.dryRun });
      touchLast(agentId);
      scheduleNextPost(agentId);
      console.log(
        `[${network}] ${result.dryRun ? '[dry-run] ' : ''}posted ${item.id} for agent ${agentId}` +
          (result.url ? ` -> ${result.url}` : '')
      );
      return { tweeted: true, posted: true, dryRun: result.dryRun, postId: item.id };
    } catch (err) {
      const postSpecific = err.code === 'FORBIDDEN';
      if (postSpecific) {
        recordResult(item.id, { text, dryRun: dryRun(), error: err.message });
        scheduleNextPost(agentId);
      } else {
        // Account-level: leave the post untouched so it is retried once the underlying cause
        // (auth, billing, rate limit) clears, rather than burning through the whole queue
        // marking every post failed for a problem none of them caused.
        scheduleNextPost(agentId, Date.now(), err.retryAfter ? err.retryAfter * 1000 + 1000 : retryMs);
      }
      console.error(`[${network}] failed for agent ${agentId} (${err.code || 'ERR'}): ${err.message}`);
      return { tweeted: false, posted: false, reason: err.code || 'ERROR', error: err.message };
    }
  }

  async function postNowGuarded(agentId) {
    if (posting.has(agentId)) return { tweeted: false, posted: false, reason: 'post-already-in-flight' };
    posting.add(agentId);
    try {
      return await postOne(agentId);
    } finally {
      posting.delete(agentId);
    }
  }

  /** Called from the main tick for every active, in-window agent. */
  async function tickCheck(agent, now) {
    if (!isEnabled(agent) || posting.has(agent.id)) return;
    const due = agent[`next_${network === 'twitter' ? 'tweet' : 'skeet'}_at`];
    const dueMs = due ? new Date(due).getTime() : 0;
    if (now < dueMs) return;
    posting.add(agent.id);
    try {
      await postOne(agent.id);
    } finally {
      posting.delete(agent.id);
    }
  }

  function info(agent, agentActiveState, windowOpen) {
    const due = agent[`next_${network === 'twitter' ? 'tweet' : 'skeet'}_at`];
    const last = agent[`last_${network === 'twitter' ? 'tweet' : 'skeet'}_at`];
    return {
      enabled: isEnabled(agent),
      nextTweetAt: isEnabled(agent) && agentActiveState === 'active' && windowOpen ? due : null,
      lastTweetAt: last,
      cadence: cadence(),
      isTweetingNow: posting.has(agent.id),
    };
  }

  return { network, cadence, scheduleNextPost, setPosting, postNowGuarded, tickCheck, info, isPosting: (id) => posting.has(id) };
}

const twitterScheduler = makeSocialScheduler({
  network: 'twitter', envPrefix: 'TWEET', defaultMinH: 3, defaultMaxH: 5, defaultWaitMin: 20, defaultRetryMin: 15,
  isEnabled: twitterEnabled, setEnabled: setTwitterEnabled, setNext: setNextTweet, touchLast: touchLastTweet,
  getNextUnposted: getNextUntweetedPost, recordResult: recordTweetResult,
  post: postTweet, compose: composeTweet, dryRun: twitterDryRun,
});

const blueskyScheduler = makeSocialScheduler({
  network: 'bluesky', envPrefix: 'SKEET', defaultMinH: 3, defaultMaxH: 5, defaultWaitMin: 20, defaultRetryMin: 15,
  isEnabled: blueskyEnabled, setEnabled: setBlueskyEnabled, setNext: setNextSkeet, touchLast: touchLastSkeet,
  getNextUnposted: getNextUnskeetedPost, recordResult: recordSkeetResult,
  post: postSkeet, compose: composeSkeet, dryRun: blueskyDryRun,
});

export const tweetCadenceDescription = twitterScheduler.cadence;
export const scheduleNextTweet = twitterScheduler.scheduleNextPost;
export const setTweeting = twitterScheduler.setPosting;
export const tweetNowGuarded = twitterScheduler.postNowGuarded;
export const isTweeting = twitterScheduler.isPosting;

export const skeetCadenceDescription = blueskyScheduler.cadence;
export const scheduleNextSkeet = blueskyScheduler.scheduleNextPost;
export const setSkeeting = blueskyScheduler.setPosting;
export const skeetNowGuarded = blueskyScheduler.postNowGuarded;
export const isSkeeting = blueskyScheduler.isPosting;

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
      `tweet cadence ${tweetCadenceDescription()}${twitterDryRun() ? ' (DRY RUN)' : ''}, ` +
      `bluesky cadence ${skeetCadenceDescription()}${blueskyDryRun() ? ' (DRY RUN)' : ''}`
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

    // Each social network has its own on/off switch and its own due-time, checked
    // independently of the write cycle and of each other — an agent can tweet without
    // skeeting, skeet without tweeting, both, or neither.
    if (active && withinWindow) {
      await twitterScheduler.tickCheck(agent, now);
      await blueskyScheduler.tickCheck(agent, now);
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
    twitter: twitterScheduler.info(a, state, windowOpen),
    bluesky: blueskyScheduler.info(a, state, windowOpen),
  };
}

export { db };
