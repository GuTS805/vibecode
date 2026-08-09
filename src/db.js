import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR is overridable so Render can point it at a mounted persistent disk.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');

// Created automatically on first run if it doesn't exist.
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

// WAL survives restarts better and tolerates the cron loop writing while HTTP reads.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    domain         TEXT NOT NULL,
    persona_prompt TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    last_cycle_at  TEXT,
    next_cycle_at  TEXT,
    expires_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    rationale  TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '[]',
    topic_key  TEXT,
    tag        TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rejections (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    topic      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    topic_key  TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_agent      ON posts(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rejections_agent ON rejections(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_topickey   ON posts(agent_id, topic_key);
`);

/**
 * Additive migrations. CREATE TABLE IF NOT EXISTS is a no-op against a database created
 * by an earlier version, so new columns are added here — a redeploy onto an existing
 * disk must not lose published posts.
 */
function ensureColumn(table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('agents', 'persona_json', 'persona_json TEXT');
ensureColumn('posts', 'title', 'title TEXT');
ensureColumn('posts', 'score', 'score INTEGER');
ensureColumn('rejections', 'url', 'url TEXT');
ensureColumn('rejections', 'score', 'score INTEGER');
// Post presentation: generated artwork plus the structure that makes a feed of posts read
// as varied rather than as one template repeated.
// Manual lifecycle control. Modelled as a state rather than a boolean so "paused" (the
// operator will decide later) stays distinguishable from "stopped" (the operator is done),
// which the UI and the scheduler need to treat differently.
ensureColumn('agents', 'state', "state TEXT NOT NULL DEFAULT 'active'");
ensureColumn('agents', 'state_changed_at', 'state_changed_at TEXT');
ensureColumn('posts', 'image_url', 'image_url TEXT');
ensureColumn('posts', 'image_prompt', 'image_prompt TEXT');
ensureColumn('posts', 'takeaway', 'takeaway TEXT');
ensureColumn('posts', 'format', 'format TEXT');
// X (Twitter) posting: an opt-in per agent, decoupled from the discover/judge/write cycle so
// tweeting runs on its own cadence and a cycle that publishes two posts does not tweet twice
// in the same breath.
ensureColumn('agents', 'twitter_enabled', 'twitter_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('agents', 'next_tweet_at', 'next_tweet_at TEXT');
ensureColumn('agents', 'last_tweet_at', 'last_tweet_at TEXT');
// Recorded per post rather than in a separate table: a tweet is an attribute of the post it
// promotes, and posts are already the append-only record everything else hangs off.
ensureColumn('posts', 'tweet_id', 'tweet_id TEXT');
ensureColumn('posts', 'tweet_url', 'tweet_url TEXT');
ensureColumn('posts', 'tweet_text', 'tweet_text TEXT');
ensureColumn('posts', 'tweet_posted_at', 'tweet_posted_at TEXT');
ensureColumn('posts', 'tweet_dry_run', 'tweet_dry_run INTEGER');
ensureColumn('posts', 'tweet_error', 'tweet_error TEXT');
// Bluesky mirrors the Twitter columns exactly — same shape, different network, both optional
// and independent per agent.
ensureColumn('agents', 'bluesky_enabled', 'bluesky_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('agents', 'next_skeet_at', 'next_skeet_at TEXT');
ensureColumn('agents', 'last_skeet_at', 'last_skeet_at TEXT');
ensureColumn('posts', 'skeet_id', 'skeet_id TEXT');
ensureColumn('posts', 'skeet_url', 'skeet_url TEXT');
ensureColumn('posts', 'skeet_text', 'skeet_text TEXT');
ensureColumn('posts', 'skeet_posted_at', 'skeet_posted_at TEXT');
ensureColumn('posts', 'skeet_dry_run', 'skeet_dry_run INTEGER');
ensureColumn('posts', 'skeet_error', 'skeet_error TEXT');

export const nowISO = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const newId = (prefix) => `${prefix}${randomUUID().slice(0, 8)}`;

/* ---------------------------------- agents --------------------------------- */

export function createAgent({ name, domain, personaPrompt, persona, autonomyHours }) {
  const id = newId('a');
  const now = new Date();
  db.prepare(
    `INSERT INTO agents (id, name, domain, persona_prompt, persona_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    domain,
    personaPrompt,
    JSON.stringify(persona),
    now.toISOString(),
    new Date(now.getTime() + autonomyHours * 3600_000).toISOString()
  );
  return getAgent(id);
}

export const getAgent = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
export const listAgents = () => db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all();

/**
 * The persona config is stored per agent, so a restart mid-window resumes with the exact
 * voice it was initialized with even if persona.json is edited in the meantime.
 */
export function loadPersona(agent) {
  try {
    const parsed = JSON.parse(agent.persona_json);
    if (parsed && parsed.voice && parsed.post) return parsed;
  } catch { /* fall through */ }
  throw new Error(`Agent ${agent.id} has no usable persona config stored.`);
}

/* ------------------------------ lifecycle state ----------------------------- */

export const AGENT_STATES = ['active', 'paused', 'stopped'];

/**
 * Set an agent's lifecycle state.
 *
 * `stopped` is final: it also closes the autonomy window, so a stopped agent cannot be
 * revived by flipping the state back. That is deliberate — "stop" should mean stopped, and
 * an operator who wants it running again can initialize a fresh agent. `paused` leaves the
 * window untouched, so the 48 hours keep elapsing while the agent sits idle.
 */
export function setAgentState(agentId, state) {
  if (!AGENT_STATES.includes(state)) throw new Error(`Unknown agent state: ${state}`);
  const now = new Date().toISOString();

  if (state === 'stopped') {
    db.prepare('UPDATE agents SET state = ?, state_changed_at = ?, expires_at = ? WHERE id = ?')
      .run(state, now, now, agentId);
  } else {
    db.prepare('UPDATE agents SET state = ?, state_changed_at = ? WHERE id = ?').run(state, now, agentId);
  }
  return getAgent(agentId);
}

/** Rows created before the state column existed have no value; treat those as active. */
export const agentState = (agent) => agent?.state || 'active';

/** When the next autonomous cycle is due. */
export function setNextCycle(agentId, nextCycleAt) {
  db.prepare('UPDATE agents SET next_cycle_at = ? WHERE id = ?').run(nextCycleAt, agentId);
}

/** Stamped when a cycle actually finishes, from any trigger source. */
export function touchLastCycle(agentId) {
  db.prepare('UPDATE agents SET last_cycle_at = ? WHERE id = ?')
    .run(new Date().toISOString(), agentId);
}

/* ---------------------------------- posts ---------------------------------- */

export function insertPost({
  agentId, title, text, rationale, sources, topicKey, tag, score,
  imageUrl = null, imagePrompt = null, takeaway = null, format = null,
}) {
  const id = newId('p');
  db.prepare(
    `INSERT INTO posts
       (id, agent_id, title, text, rationale, sources, topic_key, tag, score,
        image_url, image_prompt, takeaway, format, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, agentId, title, text, rationale, JSON.stringify(sources || []), topicKey, tag, score,
    imageUrl, imagePrompt, takeaway, format, nowISO()
  );
  return id;
}

/** Published posts are only ever read and appended — never updated or deleted. */
export function getPosts(agentId) {
  return db
    .prepare('SELECT * FROM posts WHERE agent_id = ? ORDER BY datetime(created_at) DESC, rowid DESC')
    .all(agentId)
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      title: r.title || null,
      text: r.text,
      rationale: r.rationale,
      sources: safeParse(r.sources),
      tag: r.tag || null,
      // Additive: posts written before these columns existed return null and the UI
      // renders them text-only rather than breaking.
      imageUrl: r.image_url || null,
      takeaway: r.takeaway || null,
      format: r.format || null,
      // tweet_posted_at is stamped on every attempt, success or failure, so a failed post is
      // not retried forever against a permanent cause. `postedAt` is therefore only set on
      // the JSON side when the attempt actually succeeded; a failed attempt surfaces through
      // `error` instead, with `attemptedAt` recording when it was tried.
      tweet: r.tweet_posted_at
        ? {
            id: r.tweet_id || null,
            url: r.tweet_url || null,
            text: r.tweet_text || null,
            dryRun: Boolean(r.tweet_dry_run),
            error: r.tweet_error || null,
            attemptedAt: r.tweet_posted_at,
            postedAt: r.tweet_error ? null : r.tweet_posted_at,
          }
        : null,
      skeet: r.skeet_posted_at
        ? {
            id: r.skeet_id || null,
            url: r.skeet_url || null,
            text: r.skeet_text || null,
            dryRun: Boolean(r.skeet_dry_run),
            error: r.skeet_error || null,
            attemptedAt: r.skeet_posted_at,
            postedAt: r.skeet_error ? null : r.skeet_posted_at,
          }
        : null,
    }));
}

/* -------------------------------- rejections -------------------------------- */

export function insertRejection({ agentId, topic, reason, topicKey, url, score }) {
  const id = newId('r');
  db.prepare(
    `INSERT INTO rejections (id, agent_id, topic, reason, topic_key, url, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, topic, reason, topicKey, url, score, nowISO());
  return id;
}

export function getRejections(agentId) {
  return db
    .prepare('SELECT * FROM rejections WHERE agent_id = ? ORDER BY datetime(created_at) DESC, rowid DESC')
    .all(agentId)
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      topic: r.topic,
      reason: r.reason,
      url: r.url || null,
      score: r.score ?? null,
    }));
}

/* ---------------------------------- memory ---------------------------------- */

/** How many published posts the agent carries into discovery, judging, and writing. */
const MEMORY_POSTS = Number(process.env.MEMORY_POSTS || 20);

/**
 * Everything the agent remembers: recent published posts in full enough detail to avoid
 * repeating itself, plus the topic keys of every story it has already published or
 * rejected, so those never reach a judging call again.
 */
export function getMemory(agentId) {
  const published = db
    .prepare(
      'SELECT title, text, topic_key, created_at, format FROM posts WHERE agent_id = ? ORDER BY rowid DESC LIMIT ?'
    )
    .all(agentId, MEMORY_POSTS);

  const allKeys = db
    .prepare(
      `SELECT topic_key FROM posts WHERE agent_id = ?
       UNION
       SELECT topic_key FROM rejections WHERE agent_id = ?`
    )
    .all(agentId, agentId);

  return {
    publishedSummaries: published.map((p) => ({
      createdAt: (p.created_at || '').slice(0, 10),
      title: p.title || p.text.slice(0, 80),
      excerpt: p.text.slice(0, 180),
    })),
    publishedTopics: published.map((p) => p.title).filter(Boolean),
    seenKeys: new Set(allKeys.map((r) => r.topic_key).filter(Boolean)),
    // Newest first: the writer avoids the structures it just used.
    recentFormats: published.map((p) => p.format).filter(Boolean),
  };
}

/* ------------------------------- social posting ------------------------------- */

/**
 * X and Bluesky are wired identically: an enable flag and a next/last timestamp on the agent
 * row, and a tweet_id/url/text/dry_run/error/posted_at group on each post recording whether
 * and how it was promoted. Rather than hand-write that CRUD twice, one factory generates both
 * networks' operations from their column prefixes — the SQL shape is the interesting part and
 * it is identical, so only the prefix should differ. A third network (there was a real "add
 * Mastodon too" option on the table when this shipped) is a one-line addition, not a copy of
 * this whole block with `bluesky` swapped for `mastodon` and one typo away from a silent bug.
 */
function makeSocialOps(network, { enabledCol, nextCol, lastCol, idCol, urlCol, textCol, dryRunCol, errorCol, postedCol }) {
  const setEnabled = (agentId, enabled) => {
    db.prepare(`UPDATE agents SET ${enabledCol} = ? WHERE id = ?`).run(enabled ? 1 : 0, agentId);
    return getAgent(agentId);
  };

  const isEnabled = (agent) => Boolean(agent?.[enabledCol]);

  const setNext = (agentId, nextAt) => {
    db.prepare(`UPDATE agents SET ${nextCol} = ? WHERE id = ?`).run(nextAt, agentId);
  };

  const touchLast = (agentId) => {
    db.prepare(`UPDATE agents SET ${lastCol} = ? WHERE id = ?`).run(new Date().toISOString(), agentId);
  };

  // Oldest first, not newest: promotion is decoupled from the write cycle and runs slower, so
  // a burst of two or three posts from one cycle reaches the timeline in the order they were
  // published rather than the most recent one jumping the queue.
  const getNextUnposted = (agentId) =>
    db
      .prepare(
        `SELECT * FROM posts WHERE agent_id = ? AND ${postedCol} IS NULL
         ORDER BY datetime(created_at) ASC, rowid ASC LIMIT 1`
      )
      .get(agentId);

  // A failure is recorded too (as an error, with the posted-at column left null) rather than
  // left unmarked, so a transient failure does not retry the same post forever if the
  // underlying cause is not transient — the caller decides whether to leave it eligible for
  // the next tick or mark it permanently attempted.
  const recordResult = (postId, { id = null, url = null, text, dryRun, error = null, attempted = true }) => {
    db.prepare(
      `UPDATE posts SET ${idCol} = ?, ${urlCol} = ?, ${textCol} = ?, ${dryRunCol} = ?, ${errorCol} = ?, ${postedCol} = ?
       WHERE id = ?`
    ).run(id, url, text, dryRun ? 1 : 0, error, attempted ? nowISO() : null, postId);
  };

  return { network, setEnabled, isEnabled, setNext, touchLast, getNextUnposted, recordResult };
}

const twitterOps = makeSocialOps('twitter', {
  enabledCol: 'twitter_enabled', nextCol: 'next_tweet_at', lastCol: 'last_tweet_at',
  idCol: 'tweet_id', urlCol: 'tweet_url', textCol: 'tweet_text',
  dryRunCol: 'tweet_dry_run', errorCol: 'tweet_error', postedCol: 'tweet_posted_at',
});

const blueskyOps = makeSocialOps('bluesky', {
  enabledCol: 'bluesky_enabled', nextCol: 'next_skeet_at', lastCol: 'last_skeet_at',
  idCol: 'skeet_id', urlCol: 'skeet_url', textCol: 'skeet_text',
  dryRunCol: 'skeet_dry_run', errorCol: 'skeet_error', postedCol: 'skeet_posted_at',
});

export const setTwitterEnabled = twitterOps.setEnabled;
export const twitterEnabled = twitterOps.isEnabled;
export const setNextTweet = twitterOps.setNext;
export const touchLastTweet = twitterOps.touchLast;
export const getNextUntweetedPost = twitterOps.getNextUnposted;
export const recordTweetResult = twitterOps.recordResult;

export const setBlueskyEnabled = blueskyOps.setEnabled;
export const blueskyEnabled = blueskyOps.isEnabled;
export const setNextSkeet = blueskyOps.setNext;
export const touchLastSkeet = blueskyOps.touchLast;
export const getNextUnskeetedPost = blueskyOps.getNextUnposted;
export const recordSkeetResult = blueskyOps.recordResult;

export function countStats(agentId) {
  const accepted = db.prepare('SELECT COUNT(*) c FROM posts WHERE agent_id = ?').get(agentId).c;
  const rejected = db.prepare('SELECT COUNT(*) c FROM rejections WHERE agent_id = ?').get(agentId).c;
  return { accepted, rejected, evaluated: accepted + rejected };
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
