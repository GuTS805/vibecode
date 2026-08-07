import { Router } from 'express';
import {
  createAgent, getAgent, listAgents, getPosts, getRejections, countStats,
} from './db.js';
import { buildPersonaPrompt } from './pipeline.js';
import {
  primeFirstCycle, runCycleGuarded, schedulerInfo, AUTONOMY_HOURS, isRunning,
} from './scheduler.js';
import { getActiveModel } from './gemini.js';

export const router = Router();

const bad = (res, msg) => res.status(400).json({ error: msg });

/** Resolves ?agentId= and 404s consistently. */
function requireAgent(req, res) {
  const agentId = req.query.agentId || req.body?.agentId;
  if (!agentId) {
    bad(res, 'agentId is required');
    return null;
  }
  const agent = getAgent(agentId);
  if (!agent) {
    res.status(404).json({ error: `No agent with id ${agentId}` });
    return null;
  }
  return agent;
}

/* ------------------------------- POST /init -------------------------------- */

router.post('/agent/init', (req, res) => {
  const persona = req.body?.persona;
  if (!persona || typeof persona !== 'object') {
    return bad(res, 'Body must be { "persona": { "name": "...", "domain": "..." } }');
  }
  const name = String(persona.name || '').trim();
  const domain = String(persona.domain || '').trim();
  if (!name || !domain) return bad(res, 'persona.name and persona.domain are both required');
  if (name.length > 60 || domain.length > 120) return bad(res, 'persona.name or persona.domain is too long');

  const agent = createAgent({
    name,
    domain,
    personaPrompt: buildPersonaPrompt({ name, domain }),
    autonomyHours: AUTONOMY_HOURS,
  });

  // One API call is all it takes: the autonomous loop is now live for this agent.
  primeFirstCycle(agent.id);

  console.log(`[init] agent ${agent.id} "${name}" beat="${domain}" autonomy=${AUTONOMY_HOURS}h`);
  res.json({ agentId: agent.id });
});

/* -------------------------------- GET /feed -------------------------------- */

router.get('/agent/feed', (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  // Newest-first, unique ids, ISO 8601 UTC, read straight from SQLite so history persists.
  res.json({ posts: getPosts(agent.id) });
});

/* ------------------------------- GET /status ------------------------------- */

router.get('/agent/status', (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  const stats = countStats(agent.id);
  const sched = schedulerInfo(agent.id);
  res.json({
    agentId: agent.id,
    persona: { name: agent.name, domain: agent.domain },
    initializedAt: agent.created_at,
    topicsEvaluated: stats.evaluated,
    accepted: stats.accepted,
    rejected: stats.rejected,
    acceptanceRate: stats.evaluated ? Number((stats.accepted / stats.evaluated).toFixed(3)) : 0,
    lastCycleAt: sched.lastCycleAt,
    nextCycleAt: sched.nextCycleAt,
    cycleCadence: sched.cycleCadence,
    autonomyExpiresAt: sched.autonomyExpiresAt,
    autonomyActive: sched.autonomyActive,
    cycleRunningNow: sched.isRunningNow,
    model: getActiveModel(),
  });
});

/* ----------------------------- GET /rejections ----------------------------- */

router.get('/agent/rejections', (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  res.json({ rejections: getRejections(agent.id) });
});

/* ------------------------------ POST /trigger ------------------------------ */

/**
 * Demo convenience only. Runs one cycle immediately and does NOT touch next_cycle_at,
 * so the autonomous cron loop continues on its own schedule whether or not this is
 * ever called. See README > Requirement mapping.
 */
router.post('/agent/trigger', async (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  if (isRunning(agent.id)) {
    return res.status(409).json({ error: 'A cycle is already running for this agent' });
  }
  try {
    const result = await runCycleGuarded(agent.id, 'manual');
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'QUOTA_EXHAUSTED') {
      console.warn('[trigger] quota exhausted:', err.daily ? 'daily' : 'per-minute');
      return res.status(429).json({
        error: err.message,
        code: 'QUOTA_EXHAUSTED',
        daily: err.daily,
        retryAfter: err.retryAfter,
      });
    }
    console.error('[trigger]', err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------- GET /agents ------------------------------- */

/** Powers the frontend agent switcher; multiple personas run in parallel. */
router.get('/agents', (_req, res) => {
  res.json({
    agents: listAgents().map((a) => ({
      agentId: a.id,
      name: a.name,
      domain: a.domain,
      createdAt: a.created_at,
      posts: countStats(a.id).accepted,
    })),
  });
});

router.get('/health', (_req, res) => {
  res.json({ ok: true, agents: listAgents().length, model: getActiveModel(), uptime: process.uptime() });
});
