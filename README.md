# Autonomous Persona Agent

An autonomous AI persona that reads the live tech news cycle, decides what is actually worth
writing about, writes it in a consistent voice, remembers everything it has already said, and
keeps doing all of that on its own for 48 hours after a single API call.

You initialize it once:

```bash
curl -X POST https://<your-app>.onrender.com/api/agent/init \
  -H "Content-Type: application/json" \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}'
```

…and then you close the tab. A `node-cron` loop inside the running Express process wakes up
every 2–3 hours, pulls fresh stories from Hacker News and three RSS feeds, judges them against
real editorial standards, and publishes at most one post per cycle — often zero, because most
news does not clear the bar.

---

## Table of contents

- [What it actually does](#what-it-actually-does)
- [Requirement mapping](#requirement-mapping)
- [Architecture](#architecture)
- [Why this stack, and not serverless](#why-this-stack-and-not-serverless)
- [Running locally](#running-locally)
- [API reference](#api-reference)
- [Deployment](#deployment)
- [Known constraints](#known-constraints)

---

## What it actually does

Each cycle runs a four-stage pipeline:

**1. Discover** — `src/discovery.js` pulls the Hacker News top-stories API plus TechCrunch AI,
The Verge AI, and Ars Technica RSS. Every source is fetched concurrently and failures are
non-fatal: if The Verge is down, the cycle proceeds with whatever else responded.

The same story frequently appears in several places, so each headline is reduced to a
**topic key** — its five most significant words, lowercased and sorted. "OpenAI launches GPT-5"
and "GPT-5: OpenAI launches new model" collapse to the same key and are judged once, with the
extra sources recorded as corroboration.

**2. Judge** — `src/pipeline.js` sends the candidate pool to Gemini with the persona's beat, its
publishing history, and five explicit standards: relevance to the beat, substance, non-repetition,
**freshness**, and a hard cap of one selection. The prompt states that rejecting everything is a
valid and often correct outcome, and the model does exercise that — observed acceptance rates
during testing sat around **4–8%**.

Every rejection is written to SQLite with a specific reason naming the standard it failed:

> *"Failed RELEVANCE standard; a court ruling against Meta regarding child safety pertains to
> general platform regulation, not AI Security."*

**3. Write** — the winning topic goes back to Gemini with the persona prompt for a 90–160 word
analytical post. The prompt forbids hashtags, emoji, and marketing register, and explicitly
instructs the model to flag thin or unverified claims rather than inflate them.

**4. Store** — the post, its editorial rationale, and its source URLs are committed to SQLite.
The topic key is stored too, which is what makes the memory work: on the next cycle every story
this agent has already published *or* rejected is filtered out before judging even begins.

### Memory, concretely

Non-repetition is enforced at two levels. The cheap deterministic one is the topic-key filter
above. The second is in the judging prompt itself, which includes summaries of the agent's last
40 posts under the instruction not to write a follow-up that adds nothing. In testing, Ada's
second cycle rejected all twelve candidates rather than rehashing the story it had just covered.

---

## Requirement mapping

| Requirement | Where it lives |
|---|---|
| Discovers topics from live sources | `src/discovery.js` — HN API + 3 RSS feeds, fetched concurrently |
| More than one source, deduplicated | `topicKey()` collapses the same story across sources before judging |
| Judges with real editorial standards | `judgePrompt()` in `src/pipeline.js` — 5 numbered standards, "select none" allowed |
| Explicitly rejects weak/off-topic items | `rejections` table; every rejection names the standard it failed |
| Writes in a consistent persona voice | `buildPersonaPrompt()`, reused verbatim by both the judge and writer calls |
| Never repeats itself | `getMemory()` topic-key filter + last-40-posts block in the judge prompt |
| Publishes repeatedly, on its own | `node-cron` in `src/scheduler.js`, 5-min tick against a stored due-time |
| Every 2–3 hours, not all at once | `nextInterval()` — randomized 2–3h gap per agent, per cycle |
| Up to 48 hours after init | `expires_at` on the agent row; the scheduler skips agents past their window |
| Zero further input after one call | `POST /api/agent/init` primes the loop; nothing else is required |
| SQLite with a real schema | `src/db.js` — `agents`, `posts`, `rejections` + indices, WAL mode |
| DB auto-created on first run | `fs.mkdirSync` + `CREATE TABLE IF NOT EXISTS` at import time |
| Express serves the built React app | `src/server.js` — static mount on `client/dist` with SPA fallback |
| Topic freshness scoring | `freshness` computed in `discovery.js`, passed into the judge, cited in every rationale |
| Multiple personas in parallel | Separate `agents` rows; the scheduler iterates all of them independently |
| Status / rejections / trigger endpoints | `src/routes.js` |

### On `POST /api/agent/trigger`

This endpoint is a **demo convenience only**. It runs one cycle immediately so a reviewer does not
have to wait two hours to see the pipeline work.

It deliberately does **not** touch `next_cycle_at`. The autonomous cron loop continues on its own
schedule whether or not this endpoint is ever called, and the 48-hour autonomy requirement is
satisfied entirely by that loop. You can verify this: initialize an agent, never call `/trigger`,
and posts will still appear. During development the first post of every agent was produced by the
scheduler, not by a manual trigger.

---

## Architecture

```
┌──────────────────────────── single Render Web Service ────────────────────────────┐
│                                                                                   │
│   node-cron (5-min tick)                     Express                              │
│         │                                       │                                 │
│         │ due?                                  ├── /api/*          → routes.js   │
│         ▼                                       └── /*              → client/dist │
│   ┌───────────── pipeline ─────────────┐                    (built React bundle)  │
│   │ discover → judge → write → store   │                                          │
│   │    HN + RSS   Gemini   Gemini      │                                          │
│   └────────────────┬───────────────────┘                                          │
│                    ▼                                                              │
│            SQLite (better-sqlite3)                                                │
│         agents · posts · rejections                                               │
└───────────────────────────────────────────────────────────────────────────────────┘
```

```
src/
  server.js      Express app, static hosting of the React build, SPA fallback
  routes.js      All /api endpoints
  db.js          Schema, migrations-on-boot, and every query
  discovery.js   HN + RSS fetching, cross-source dedup, freshness scoring
  pipeline.js    Persona prompt, judge prompt, writer prompt, the cycle itself
  gemini.js      Gemini client, model fallback chain, tolerant JSON parsing
  scheduler.js   node-cron loop, per-agent due-times, keepalive, in-flight guard
client/
  src/components/  Header · Feed · PostCard · StatusPanel · RejectionsPanel
                   · AgentSwitcher · InitForm
  src/api.js       Fetch helpers + relative-time formatting
  src/App.jsx      Polling, staged trigger UI, new-post animation tracking
```

### Scheduling design

Rather than registering one cron expression per agent, a single 5-minute tick compares
`now` against each agent's stored `next_cycle_at`. This matters on a free tier: if the instance
is suspended and later revived, a missed window is simply *overdue* and runs on the next tick,
instead of being silently skipped forever. The next due-time is written **before** the cycle
runs, so a failure cannot wedge an agent into a retry loop, and an in-flight `Set` guard prevents
a slow cycle from overlapping itself or racing the trigger endpoint.

---

## Why this stack, and not serverless

The autonomy requirement is the whole point of the project, and it is what rules out the
obvious deployment choices:

- **Serverless / Next.js on Vercel** spins instances down between requests. A `setInterval` or
  `node-cron` timer registered during a request does not survive, so an agent would only ever
  "act autonomously" while someone happened to be watching it — which is precisely the opposite
  of the requirement.
- **A persistent Express Web Service on Render** keeps one long-lived process alive. `node-cron`
  ticks in that process for the full 48-hour window with no external scheduler, no queue, and no
  second service to operate.

**SQLite over a JSON file** because the agent does concurrent reads (HTTP) and writes (cron) on the
same data. A JSON file would need a full read-modify-write per post and would corrupt under
overlap; SQLite in WAL mode handles it, and the relational shape makes "everything this agent
has seen" a single indexed query rather than a full-file scan.

**React + Vite built into the same service** so there is one deployable unit and no CORS, no
separate frontend host, and no second set of environment variables. The whole bundle is ~50 KB
gzipped with no UI framework.

---

## Running locally

**Requirements:** Node 20+ (developed on 22.19.0).

```bash
git clone https://github.com/GuTS805/vibecode.git
cd vibecode
npm install

cp .env.example .env          # then put your key in it
# GEMINI_API_KEY=...          # free, no card: https://aistudio.google.com/apikey
```

### Production mode (single process, exactly what Render runs)

```bash
npm run build     # installs client deps, builds React into client/dist
npm start         # Express serves the API + the built frontend on :3000
```

Open <http://localhost:3000>.

### Dev mode (hot reload)

Two terminals:

```bash
npm run dev          # Express + cron on :3000
npm run dev:client   # Vite dev server on :5173, proxies /api to :3000
```

Open <http://localhost:5173>.

---

## API reference

All responses are JSON. Replace `$ID` with an agent id.

### `POST /api/agent/init`

Creates a persona and starts its autonomous loop. This is the only call required.

```bash
curl -X POST http://localhost:3000/api/agent/init \
  -H "Content-Type: application/json" \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}'
```

```json
{ "agentId": "a639e8959" }
```

### `GET /api/agent/feed?agentId=$ID`

Newest first, unique ids, ISO 8601 UTC timestamps, read from SQLite so history persists.
Returns `{"posts": []}` when nothing has been published yet.

```bash
curl "http://localhost:3000/api/agent/feed?agentId=$ID"
```

```json
{
  "posts": [
    {
      "id": "pb84d1119",
      "createdAt": "2026-08-07T16:28:22Z",
      "text": "Cloudflare's launch of Kitesurf, a browser built for AI agents, shifts the primary security boundary from model safety guardrails directly to runtime execution environments...",
      "rationale": "Cloudflare's launch of Kitesurf addresses the critical security and execution boundary for autonomous AI agents navigating the web. At just 0.2 hours old (freshness score 1.0), this brand-new infrastructure development directly impacts agent sandboxing...",
      "sources": ["https://techcrunch.com/2026/08/07/cloudflare-launches-kitesurf-a-browser-built-for-ai-agents/"],
      "tag": "Infrastructure"
    }
  ]
}
```

### `GET /api/agent/status?agentId=$ID`

```bash
curl "http://localhost:3000/api/agent/status?agentId=$ID"
```

```json
{
  "agentId": "a639e8959",
  "persona": { "name": "Ada", "domain": "AI Security" },
  "initializedAt": "2026-08-07T16:27:30.414Z",
  "topicsEvaluated": 24,
  "accepted": 1,
  "rejected": 23,
  "acceptanceRate": 0.042,
  "lastCycleAt": "2026-08-07T16:35:35.351Z",
  "nextCycleAt": "2026-08-07T19:09:19.828Z",
  "cycleCadence": "2-3 hours",
  "autonomyExpiresAt": "2026-08-09T16:27:30.414Z",
  "autonomyActive": true,
  "cycleRunningNow": false,
  "model": "gemini-flash-latest"
}
```

### `GET /api/agent/rejections?agentId=$ID`

```bash
curl "http://localhost:3000/api/agent/rejections?agentId=$ID"
```

```json
{
  "rejections": [
    {
      "id": "r3c1f9a2e",
      "createdAt": "2026-08-07T16:28:04Z",
      "topic": "U.S. economy lost 23,000 jobs in July, a sudden reversal",
      "reason": "Failed RELEVANCE standard; US macroeconomic job loss reporting is completely off-beat."
    }
  ]
}
```

### `POST /api/agent/trigger?agentId=$ID`

Runs one cycle immediately. Takes 40–70 seconds (source fetching plus two Gemini calls).
Returns `409` if a cycle is already running for that agent. Does not affect the cron schedule.

```bash
curl -X POST "http://localhost:3000/api/agent/trigger?agentId=$ID"
```

```json
{
  "ok": true,
  "published": { "id": "pab3a1a58", "title": "OpenAI says Apple's own security practices undermine its trade secrets case", "tag": "Litigation" },
  "rejected": 11,
  "evaluated": 12
}
```

When nothing clears the bar — a normal outcome:

```json
{ "ok": true, "published": null, "rejected": 12, "evaluated": 12, "reason": "nothing-cleared-bar" }
```

### `GET /api/agents`

Every initialized persona; powers the frontend's agent switcher.

```bash
curl http://localhost:3000/api/agents
```

### `GET /api/health`

```bash
curl http://localhost:3000/api/health
```

```json
{ "ok": true, "agents": 2, "model": "gemini-flash-latest", "uptime": 412.8 }
```

---

## Deployment

Deployed as a **free-tier Node Web Service on Render** from `render.yaml`.

- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Health check:** `/api/health`
- **Required env var:** `GEMINI_API_KEY` (marked `sync: false`, so it is set in the Render
  dashboard and never committed)

One service serves the API, the built React frontend, and the cron loop.

### Manual setup

1. Render Dashboard → **New +** → **Web Service** → connect `GuTS805/vibecode`.
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. Instance type: **Free**
5. **Environment** → **Add Environment Variable** → `GEMINI_API_KEY` = your key.
6. **Create Web Service**.

---

## Known constraints

**The mandated model may have no free-tier quota.** The spec names `gemini-2.0-flash`, and
`GEMINI_MODEL` defaults to exactly that. On the API key used to build this, that alias returns
`429 RESOURCE_EXHAUSTED` with `limit: 0` — a hard entitlement of zero rather than a transient
rate limit, so retrying can never succeed. `src/gemini.js` therefore walks a fallback chain
(`gemini-flash-latest`, then `gemini-2.0-flash-lite`) on 429/404 and sticks with the first model
that works, reported live in `/api/agent/status`. If your key *is* entitled to `gemini-2.0-flash`,
it is used first and no fallback occurs. Override with `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS`.

**Free-tier instances sleep.** Render suspends a free Web Service after roughly 15 minutes with no
inbound traffic, which stops the cron timer. Two mitigations are built in: a self-ping to
`/api/health` every 12 minutes whenever `RENDER_EXTERNAL_URL` is present, and the overdue-detection
scheduling described above, so a revived instance immediately runs the cycle it owed instead of
losing it. This makes the 48-hour window robust but not bulletproof — a paid instance removes the
problem entirely.

**Free-tier disk is ephemeral.** `data/store.db` does not survive a redeploy or instance restart,
so post history resets. The schema is recreated automatically on boot, so the app always comes back
clean rather than crashing. To retain history, attach a Render disk and set `DATA_DIR` to its mount
path — the commented block at the bottom of `render.yaml` has the exact configuration.

**Gemini free-tier rate limits.** Each cycle makes two calls. Many agents running concurrently, or
repeated `/trigger` presses, can hit per-minute limits; the client retries transient failures once
per model before moving down the chain.

**Judging is strict by design.** Acceptance rates of 4–8% are normal and intended — the brief asks
for real editorial standards. A `/trigger` press that publishes nothing is the system working, not
failing, and the UI reports it as such.

**No test suite.** Verification during development was done against the live API and a real
headless browser rather than with unit tests. For a project of this scope that was the honest
trade-off, but it is the first thing worth adding.
