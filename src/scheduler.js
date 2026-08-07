import cron from 'node-cron';
import { listAgents, setNextCycle, touchLastCycle, getAgent, db } from './db.js';
import { runCycle } from './pipeline.js';

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
    `[scheduler] started — tick every 5min, cadence ${cadenceDescription()}, autonomy window ${AUTONOMY_HOURS}h`
  );
  // Catch up immediately on boot for anything already overdue.
  setTimeout(tick, 5_000).unref?.();
  return task;
}

async function tick() {
  const now = Date.now();
  for (const agent of listAgents()) {
    const expires = new Date(agent.expires_at).getTime();
    if (now >= expires) continue; // 48h autonomy window elapsed

    const due = agent.next_cycle_at ? new Date(agent.next_cycle_at).getTime() : 0;
    if (now < due) continue;

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

export function schedulerInfo(agentId) {
  const a = getAgent(agentId);
  if (!a) return null;
  const now = Date.now();
  const expires = new Date(a.expires_at).getTime();
  return {
    nextCycleAt: a.next_cycle_at,
    lastCycleAt: a.last_cycle_at,
    autonomyExpiresAt: a.expires_at,
    autonomyActive: now < expires,
    cycleCadence: cadenceDescription(),
    isRunningNow: running.has(a.id),
  };
}

export { db };
