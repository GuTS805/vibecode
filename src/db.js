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

export function insertPost({ agentId, title, text, rationale, sources, topicKey, tag, score }) {
  const id = newId('p');
  db.prepare(
    `INSERT INTO posts (id, agent_id, title, text, rationale, sources, topic_key, tag, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, title, text, rationale, JSON.stringify(sources || []), topicKey, tag, score, nowISO());
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
      text: r.text,
      rationale: r.rationale,
      sources: safeParse(r.sources),
      tag: r.tag || null,
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
    .prepare('SELECT title, text, topic_key, created_at FROM posts WHERE agent_id = ? ORDER BY rowid DESC LIMIT ?')
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
  };
}

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
