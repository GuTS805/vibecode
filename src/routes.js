import { Router } from 'express';
import {
  createAgent, getAgent, listAgents, listAgentsForUser, isOwnedBy, getPosts, getRejections,
  countStats, loadPersona, agentState, twitterEnabled, blueskyEnabled, deleteAgent,
} from './db.js';
import { resolvePersona, personaSystemPrompt, listRegistryPersonas } from './persona.js';
import {
  primeFirstCycle, runCycleGuarded, schedulerInfo, AUTONOMY_HOURS, isRunning, setLifecycle,
  setTweeting, tweetNowGuarded, isTweeting,
  setSkeeting, skeetNowGuarded, isSkeeting,
} from './scheduler.js';
import { getActiveModel, getTextProvider } from './llm.js';
import { isConfigured as twitterConfigured, isDryRun as twitterDryRun, verifyCredentials as verifyTwitter } from './twitter.js';
import { isConfigured as blueskyConfigured, isDryRun as blueskyDryRun, verifyCredentials as verifyBluesky } from './bluesky.js';
import { requireAuth, signUp } from './auth.js';

export const router = Router();

const bad = (res, msg) => res.status(400).json({ error: msg });

/* --------------------------------- public --------------------------------- */
/* Routes above the requireAuth mount below are reachable without signing in — deployment
   diagnostics and the persona catalogue, neither of which touches any user's data. */

/** The personas defined in persona.json, for anyone wondering what names /init knows. */
router.get('/personas', (_req, res) => res.json({ personas: listRegistryPersonas() }));

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    agents: listAgents().length,
    model: getActiveModel(),
    textProvider: getTextProvider(),
    twitterConfigured: twitterConfigured(),
    twitterDryRun: twitterDryRun(),
    blueskyConfigured: blueskyConfigured(),
    blueskyDryRun: blueskyDryRun(),
    uptime: process.uptime(),
  });
});

/**
 * Account creation, done server-side rather than by the frontend calling
 * `supabase.auth.signUp()` directly. That call requires confirming a real inbox before a
 * session is issued, and free-tier Supabase rate-limits its own confirmation-email sender
 * tightly enough that real signups failed outright while building this — see auth.js and
 * README > Multi-user auth for the specifics. This account creates already-confirmed and
 * signs in immediately.
 *
 * Public, ahead of requireAuth: signing up is how someone becomes authenticated, so it
 * cannot itself require being authenticated already.
 */
router.post('/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) return bad(res, 'email and password are both required');
  if (password.length < 6) return bad(res, 'password must be at least 6 characters');

  try {
    const user = await signUp(email, password);
    res.json({ ok: true, userId: user.id, email: user.email });
  } catch (err) {
    if (err.code === 'AUTH_NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    res.status(err.code === 'EMAIL_TAKEN' ? 409 : 500).json({ error: err.message, code: err.code });
  }
});

/* ------------------------------ everything else ----------------------------- */
/* Every route below requires a verified Supabase session. Agents, posts, and rejections are
   now scoped per user_id, and this is the one gate that makes that scoping mean anything —
   without it, an unauthenticated caller could still read or drive any agent by guessing an id. */
router.use(requireAuth);

/**
 * Resolves ?agentId= to a row this caller actually owns. 404 (not 403) on a mismatch, so the
 * response to "wrong owner" and "does not exist" look identical — otherwise the endpoint would
 * confirm which ids are real to a caller who has no business asking.
 */
function requireOwnedAgent(req, res) {
  const agentId = req.query.agentId || req.body?.agentId;
  if (!agentId) {
    bad(res, 'agentId is required');
    return null;
  }
  const agent = getAgent(agentId);
  if (!agent || !isOwnedBy(agent, req.userId)) {
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
    userId: req.userId,
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
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  // Newest-first, unique ids, ISO 8601 UTC, read straight from SQLite so history persists
  // across restarts. Published posts are append-only — never mutated or deleted.
  res.json({ posts: getPosts(agent.id) });
});

/* ------------------------------- GET /status ------------------------------- */

router.get('/agent/status', (req, res) => {
  const agent = requireOwnedAgent(req, res);
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
    // Manual lifecycle: 'active' | 'paused' | 'stopped'.
    state: sched.state,
    stateChangedAt: sched.stateChangedAt,
    twitter: {
      ...sched.twitter,
      configured: twitterConfigured(),
      dryRun: twitterDryRun(),
    },
    bluesky: {
      ...sched.bluesky,
      configured: blueskyConfigured(),
      dryRun: blueskyDryRun(),
    },
    model: getActiveModel(),
    textProvider: getTextProvider(),
    imageProvider: process.env.POST_IMAGES === 'false' ? 'disabled' : 'pollinations',
  });
});

/* ------------------------------ GET /persona ------------------------------- */

/** The full config every prompt is built from — the voice, in inspectable form. */
router.get('/agent/persona', (req, res) => {
  const agent = requireOwnedAgent(req, res);
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
  const agent = requireOwnedAgent(req, res);
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
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;

  // Pausing has to mean the agent publishes nothing. Letting a manual trigger through would
  // make "paused" mean "paused unless you press the button", which is not what an off switch
  // is for.
  const state = agentState(agent);
  if (state !== 'active') {
    return res.status(409).json({
      error:
        state === 'stopped'
          ? `${agent.name} has been stopped and will not run cycles.`
          : `${agent.name} is paused. Resume it before running a cycle.`,
      code: state === 'stopped' ? 'AGENT_STOPPED' : 'AGENT_PAUSED',
      state,
    });
  }

  if (isRunning(agent.id)) {
    return res.status(409).json({ error: 'A cycle is already running for this agent' });
  }
  try {
    const result = await runCycleGuarded(agent.id, 'manual');
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'POLLINATIONS_UNFUNDED') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (err.code === 'RATE_LIMITED' || err.code === 'GROUNDING_QUOTA' || err.code === 'POLLINATIONS_RATE_LIMITED') {
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

/* --------------------- POST /pause, /resume, /stop -------------------------- */

/**
 * Manual control over the autonomous loop.
 *
 * An agent that runs unattended for 48 hours needs an off switch, and the trigger endpoint is
 * not one — it starts work rather than stopping it. These are the only way to make a running
 * persona stop publishing without killing the process or waiting out its window.
 *
 *   pause   reversible; the 48h window keeps elapsing while it idles
 *   resume  restarts the loop, rescheduling from now if the due time has passed
 *   stop    final; also closes the autonomy window, so it cannot be resumed
 */
function lifecycleHandler(state) {
  return (req, res) => {
    const agent = requireOwnedAgent(req, res);
    if (!agent) return;

    const current = agentState(agent);
    if (current === 'stopped') {
      return res.status(409).json({
        error: `${agent.name} has been stopped and cannot be restarted. Initialize a new agent instead.`,
        code: 'AGENT_STOPPED',
        state: current,
      });
    }
    if (current === state) {
      return res.json({ ok: true, agentId: agent.id, state, unchanged: true });
    }

    const updated = setLifecycle(agent.id, state);
    res.json({
      ok: true,
      agentId: agent.id,
      name: agent.name,
      state: agentState(updated),
      // A cycle already running holds an open request to the provider; aborting it would
      // spend the quota and store nothing, so it is allowed to finish.
      cycleStillFinishing: isRunning(agent.id),
      nextCycleAt: schedulerInfo(agent.id).nextCycleAt,
    });
  };
}

router.post('/agent/pause', lifecycleHandler('paused'));
router.post('/agent/resume', lifecycleHandler('active'));
router.post('/agent/stop', lifecycleHandler('stopped'));

/**
 * Permanently removes an agent and everything it produced. Restricted to agents already
 * `stopped` — an active or paused agent can still be resumed, so deleting it would destroy
 * something recoverable; a stopped one is already a dead end, so this is a natural second
 * step rather than a separate kind of danger. The frontend surfaces this specifically to
 * clear stopped agents out of the switcher once they are no longer wanted.
 */
router.delete('/agent', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;

  if (agentState(agent) !== 'stopped') {
    return res.status(409).json({
      error: `${agent.name} must be stopped before it can be deleted.`,
      code: 'AGENT_NOT_STOPPED',
      state: agentState(agent),
    });
  }

  deleteAgent(agent.id);
  console.log(`[delete] agent ${agent.id} "${agent.name}" removed by user ${req.userId}`);
  res.json({ ok: true, agentId: agent.id });
});

/* ------------------------- X (Twitter) posting -------------------------- */

/**
 * Turn tweeting on or off for an agent. Independent of pause/resume/stop — those control
 * whether the agent keeps writing, this controls whether its posts get promoted to X.
 * Enabling schedules a check within a minute rather than the full interval, so an agent that
 * already has an unpromoted post tweets it promptly instead of hours later.
 */
router.post('/agent/twitter/enable', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  setTweeting(agent.id, true);
  res.json({
    ok: true,
    agentId: agent.id,
    enabled: true,
    dryRun: twitterDryRun(),
    configured: twitterConfigured(),
    nextTweetAt: schedulerInfo(agent.id).twitter.nextTweetAt,
  });
});

router.post('/agent/twitter/disable', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  setTweeting(agent.id, false);
  res.json({ ok: true, agentId: agent.id, enabled: false });
});

/** Tweeting status alongside the general credential/dry-run state, without needing /status. */
router.get('/agent/twitter/status', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  const sched = schedulerInfo(agent.id);
  res.json({
    agentId: agent.id,
    configured: twitterConfigured(),
    dryRun: twitterDryRun(),
    ...sched.twitter,
  });
});

/**
 * Demo convenience, parallel to /agent/trigger: tweets the oldest un-promoted post right now
 * without waiting for the scheduled check. Does not touch next_tweet_at, so the autonomous
 * loop continues on its own schedule regardless of whether this is ever called.
 */
router.post('/agent/twitter/tweet-now', async (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;

  // Mirrors /agent/trigger: a paused or stopped agent does nothing autonomous, and a manual
  // button must not be a backdoor around that — otherwise "stopped" would only stop writing,
  // not posting, which is not what stopping an agent means.
  const state = agentState(agent);
  if (state !== 'active') {
    return res.status(409).json({
      error:
        state === 'stopped'
          ? `${agent.name} has been stopped and will not tweet.`
          : `${agent.name} is paused. Resume it before tweeting.`,
      code: state === 'stopped' ? 'AGENT_STOPPED' : 'AGENT_PAUSED',
      state,
    });
  }

  if (!twitterEnabled(agent)) {
    return res.status(409).json({
      error: `Tweeting is not enabled for ${agent.name}. Call /api/agent/twitter/enable first.`,
      code: 'TWITTER_DISABLED',
    });
  }
  if (isTweeting(agent.id)) {
    return res.status(409).json({ error: 'A tweet attempt is already in flight for this agent.' });
  }

  try {
    const result = await tweetNowGuarded(agent.id);
    res.json({ ok: true, dryRun: twitterDryRun(), ...result });
  } catch (err) {
    console.error('[twitter/tweet-now]', err);
    res.status(500).json({ error: err.message, code: err.code || 'UNKNOWN' });
  }
});

/**
 * Verifies the four credential values actually authenticate, independent of the posting
 * path — useful while sorting out account/billing state without spending a tweet to find out.
 */
router.get('/twitter/verify', async (_req, res) => {
  if (!twitterConfigured()) {
    return res.status(503).json({ error: 'Twitter credentials are not set.', code: 'NO_CREDENTIALS' });
  }
  try {
    const user = await verifyTwitter();
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.code === 'AUTH_FAILED' ? 401 : 500).json({ error: err.message, code: err.code });
  }
});

/* --------------------------- Bluesky posting ----------------------------- */

/**
 * Same shape as the X (Twitter) block above — a second, independent opt-in per agent. See
 * README > X (Twitter) posting / Bluesky posting for why the free/no-billing-gate difference
 * made this worth adding as a genuine alternative rather than only documenting the gate.
 */
router.post('/agent/bluesky/enable', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  setSkeeting(agent.id, true);
  res.json({
    ok: true,
    agentId: agent.id,
    enabled: true,
    dryRun: blueskyDryRun(),
    configured: blueskyConfigured(),
    nextTweetAt: schedulerInfo(agent.id).bluesky.nextTweetAt,
  });
});

router.post('/agent/bluesky/disable', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  setSkeeting(agent.id, false);
  res.json({ ok: true, agentId: agent.id, enabled: false });
});

router.get('/agent/bluesky/status', (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;
  const sched = schedulerInfo(agent.id);
  res.json({
    agentId: agent.id,
    configured: blueskyConfigured(),
    dryRun: blueskyDryRun(),
    ...sched.bluesky,
  });
});

router.post('/agent/bluesky/tweet-now', async (req, res) => {
  const agent = requireOwnedAgent(req, res);
  if (!agent) return;

  const state = agentState(agent);
  if (state !== 'active') {
    return res.status(409).json({
      error:
        state === 'stopped'
          ? `${agent.name} has been stopped and will not post to Bluesky.`
          : `${agent.name} is paused. Resume it before posting.`,
      code: state === 'stopped' ? 'AGENT_STOPPED' : 'AGENT_PAUSED',
      state,
    });
  }

  if (!blueskyEnabled(agent)) {
    return res.status(409).json({
      error: `Bluesky posting is not enabled for ${agent.name}. Call /api/agent/bluesky/enable first.`,
      code: 'BLUESKY_DISABLED',
    });
  }
  if (isSkeeting(agent.id)) {
    return res.status(409).json({ error: 'A post attempt is already in flight for this agent.' });
  }

  try {
    const result = await skeetNowGuarded(agent.id);
    res.json({ ok: true, dryRun: blueskyDryRun(), ...result });
  } catch (err) {
    console.error('[bluesky/tweet-now]', err);
    res.status(500).json({ error: err.message, code: err.code || 'UNKNOWN' });
  }
});

router.get('/bluesky/verify', async (_req, res) => {
  if (!blueskyConfigured()) {
    return res.status(503).json({ error: 'Bluesky credentials are not set.', code: 'NO_CREDENTIALS' });
  }
  try {
    const user = await verifyBluesky();
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.code === 'AUTH_FAILED' ? 401 : 500).json({ error: err.message, code: err.code });
  }
});

/* -------------------------------- GET /agents ------------------------------- */

/**
 * Powers the frontend agent switcher. Scoped to the caller's own agents only — this is the
 * second half of what makes multi-user real: it is not enough that other users' agents 404 on
 * direct access, the roster view must not even list them.
 */
router.get('/agents', (req, res) => {
  res.json({
    agents: listAgentsForUser(req.userId).map((a) => ({
      agentId: a.id,
      name: a.name,
      domain: a.domain,
      createdAt: a.created_at,
      posts: countStats(a.id).accepted,
      state: agentState(a),
      twitterEnabled: twitterEnabled(a),
      blueskyEnabled: blueskyEnabled(a),
    })),
  });
});
