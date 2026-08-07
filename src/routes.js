import { Router } from 'express';
import {
  createAgent, getAgent, listAgents, getPosts, getRejections, countStats, loadPersona,
} from './db.js';
import { resolvePersona, personaSystemPrompt, listRegistryPersonas } from './persona.js';
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

/**
 * The only call required. It seeds persona state and starts the autonomous loop;
 * nothing further is needed for posts to keep appearing for the next 48 hours.
 */
router.post('/agent/init', (req, res) => {
  const persona = req.body?.persona;
  if (!persona || typeof persona !== 'object') {
    return bad(res, 'Body must be { "persona": { "name": "...", "domain": "..." } }');
  }
  const name = String(persona.name || '').trim();
  const domain = String(persona.domain || '').trim();
  if (!name || !domain) return bad(res, 'persona.name and persona.domain are both required');
  if (name.length > 60 || domain.length > 120) return bad(res, 'persona.name or persona.domain is too long');

  const resolved = resolvePersona({ name, domain });

  const agent = createAgent({
    name: resolved.name,
    domain: resolved.domain,
    personaPrompt: personaSystemPrompt(resolved),
    persona: resolved,
    autonomyHours: AUTONOMY_HOURS,
  });

  primeFirstCycle(agent.id);

  console.log(
    `[init] agent ${agent.id} "${resolved.name}" (${resolved.role}) beat="${resolved.domain}" ` +
      `persona=${resolved.source} autonomy=${AUTONOMY_HOURS}h`
  );
  res.json({ agentId: agent.id });
});

/* -------------------------------- GET /feed -------------------------------- */

router.get('/agent/feed', (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  // Newest-first, unique ids, ISO 8601 UTC, read straight from SQLite so history persists
  // across restarts. Published posts are append-only — never mutated or deleted.
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

/* ------------------------------ GET /persona ------------------------------- */

/** The full config every prompt is built from — the voice, in inspectable form. */
router.get('/agent/persona', (req, res) => {
  const agent = requireAgent(req, res);
  if (!agent) return;
  try {
    res.json({ agentId: agent.id, persona: loadPersona(agent) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------- GET /rejections and /debug/rejected ------------------- */

/**
 * Editorial judgment is only credible if the rejections are visible. Every candidate the
 * agent declined is logged with the standard it failed and its score, even though the
 * required API surface does not expose any of this.
 */
function rejectionsHandler(req, res) {
  const agent = requireAgent(req, res);
  if (!agent) return;
  const rejections = getRejections(agent.id);
  const stats = countStats(agent.id);
  res.json({
    agentId: agent.id,
    evaluated: stats.evaluated,
    accepted: stats.accepted,
    rejected: stats.rejected,
    acceptanceRate: stats.evaluated ? Number((stats.accepted / stats.evaluated).toFixed(3)) : 0,
    rejections,
  });
}

router.get('/agent/rejections', rejectionsHandler);
router.get('/debug/rejected', rejectionsHandler);

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
    if (err.code === 'RATE_LIMITED' || err.code === 'GROUNDING_QUOTA') {
      console.warn(`[trigger] ${err.code}`);
      return res.status(429).json({
        error: err.message,
        code: err.code,
        daily: !!err.daily,
        retryAfter: err.retryAfter,
      });
    }
    if (['AUTH_FAILED', 'NO_API_KEY', 'FORBIDDEN', 'BAD_MODEL'].includes(err.code)) {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    console.error('[trigger]', err);
    res.status(500).json({ error: err.message, code: err.code || 'UNKNOWN' });
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

/** The personas defined in persona.json, for anyone wondering what names /init knows. */
router.get('/personas', (_req, res) => res.json({ personas: listRegistryPersonas() }));

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    agents: listAgents().length,
    model: getActiveModel(),
    uptime: process.uptime(),
  });
});
