import cron from 'node-cron';
import { listAgents, setNextCycle, touchLastCycle, getAgent, db } from './db.js';
import { runCycle } from './pipeline.js';

const HOUR = 3_600_000;

/** Autonomous loop runs for this long after an agent is initialized. */
export const AUTONOMY_HOURS = Number(process.env.AUTONOMY_HOURS || 48);

const MIN_INTERVAL_H = Number(process.env.CYCLE_MIN_HOURS || 2);
const MAX_INTERVAL_H = Number(process.env.CYCLE_MAX_HOURS || 3);

/** Random 2-3h gap, so posts arrive spread over time rather than in a burst. */
function nextInterval() {
  return (MIN_INTERVAL_H + Math.random() * (MAX_INTERVAL_H - MIN_INTERVAL_H)) * HOUR;
}

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

/**
 * First cycle fires shortly after init rather than 2-3h later, so a freshly
 * initialized agent has something in its feed. Subsequent cycles use the real
 * 2-3h cadence. Fire-and-forget: /api/agent/init must not block on Gemini.
 */
export function primeFirstCycle(agentId, delayMs = 12_000) {
  scheduleNext(agentId); // real cadence is set immediately, independent of this priming run
  setTimeout(() => {
    runCycleGuarded(agentId, 'init').catch((e) => console.error('[init-cycle]', e.message));
  }, delayMs).unref?.();
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
    `[scheduler] started — tick every 5min, cycle cadence ${MIN_INTERVAL_H}-${MAX_INTERVAL_H}h, autonomy window ${AUTONOMY_HOURS}h`
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
      console.error(`[scheduler] cycle failed for ${agent.id}:`, err.message);
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
    cycleCadence: `${MIN_INTERVAL_H}-${MAX_INTERVAL_H} hours`,
    isRunningNow: running.has(a.id),
  };
}

export { db };
