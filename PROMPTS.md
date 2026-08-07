# Prompt log

A running log of the prompts that produced this project. Newest entries are appended at the
bottom.

---

## 1 — Initial build (2026-08-07)

**Summary of the request**

Build, push, and deploy an entire project end-to-end with minimal manual intervention. Before
writing any code, ask for a Gemini API key, store it only in a local `.env`, and never print,
commit, or otherwise expose it. Connect to the existing empty repo at
`https://github.com/GuTS805/vibecode` rather than creating a new one.

**The concept**

An autonomous AI persona — a tech/AI-focused character such as "an AI Security Researcher" —
that, after a single initialization call, independently and repeatedly:

1. discovers current AI/tech topics from live sources
2. judges whether each is worth writing about, with real editorial standards, explicitly
   rejecting weak, repetitive, or off-topic ones
3. writes a post in a consistent persona voice
4. remembers everything already published so it never repeats itself
5. keeps publishing over time on its own — a scheduled job every 2–3 hours, not all at once,
   for up to 48 hours after init, with zero further input

**Stack requirements (specified, not chosen)**

- Node.js + Express as a persistent Render Web Service — explicitly *not* Next.js and *not*
  serverless, because a real background `node-cron` job must survive for 48 hours and
  serverless instances spin down between requests
- SQLite via `better-sqlite3` with a real schema (`agents`, `posts`, `rejections`), stored at
  `data/store.db`, created automatically on first run
- React + Vite built to static files and served by the same Express app, so there is a single
  deployable service
- `node-cron` for scheduling; `render.yaml` for a free-tier Node Web Service
- Google Gemini via `@google/generative-ai`, model `gemini-2.0-flash`, key read from
  `process.env.GEMINI_API_KEY`, never hardcoded

**Topic discovery**

Hacker News API plus a couple of tech RSS feeds via `rss-parser`, with same-story
deduplication across sources before judging.

**Required endpoints (exact shapes given)**

- `POST /api/agent/init` → `{ "agentId": "..." }`
- `GET /api/agent/feed?agentId=...` → newest-first posts with `id`, `createdAt`, `text`,
  `rationale`, `sources`; unique ids, ISO 8601 UTC, history persists, empty array when new

**Extra features requested**

`GET /api/agent/status`, `GET /api/agent/rejections`, multiple parallel personas,
`POST /api/agent/trigger` as a documented demo convenience that does not replace the cron
loop, and topic freshness scoring reflected in the rationale.

**Frontend**

Header, Feed (30s polling, smooth card animation), PostCard (expandable rationale, clickable
sources, relative timestamps, category chip), StatusPanel, collapsible RejectionsPanel, a
"Run a cycle now" button with staged loading messages, an agent switcher, an init form, and a
deliberate empty state. Dark-mode-leaning, Google Font pairing, card-based, mobile-first at
390px, clean component file structure.

**Also required**

`README.md` mapping every requirement to its implementation, this `PROMPTS.md`, `.env.example`,
`.gitignore`, and `render.yaml`.

**Execution instructions**

Scaffold, write everything, run it locally and actually test every endpoint and the UI, fix all
errors before proceeding, push to the existing repo, deploy to Render (CLI if available,
otherwise ≤6 exact manual steps), verify the live deployment end-to-end, then summarize.

---

### Decisions made while building

Recorded here because they departed from, or added to, the letter of the prompt.

**`gemini-2.0-flash` had zero free-tier quota on the supplied key.** Verified before writing any
pipeline code: the alias returns `429 RESOURCE_EXHAUSTED` with `limit: 0`, a hard entitlement of
zero rather than a transient limit, so no retry policy could fix it. `gemini-flash-latest` on the
same key returned `200`. Rather than silently substituting the model or blocking the build,
`GEMINI_MODEL` defaults to `gemini-2.0-flash` exactly as specified and `src/gemini.js` walks a
fallback chain on 429/404. The spec is honoured, the agent runs today, and it upgrades itself
automatically if the quota is ever granted.

**Render free tier conflicts with the 48-hour autonomy requirement.** Free instances sleep after
~15 minutes of no traffic, which stops the cron timer. Added a `/api/health` self-ping every 12
minutes and, more importantly, made the scheduler compare against a *stored due-time* on a
5-minute tick instead of registering per-agent cron expressions — so a missed window is detected
as overdue and caught up after a restart rather than being lost. Documented, with the paid-tier
fix, under Known constraints.

**Candidates are pre-ranked by relevance to the agent's beat.** First observed with a second
persona: "Grace / AI Policy & Regulation" correctly rejected all twelve candidates because the
freshest twelve headlines happened to be developer tooling. Editorially right, but it meant a
niche beat could publish nothing for hours. A cheap deterministic pre-rank now orders the pool by
domain-token overlap before slicing to twelve. It only *orders* — off-beat stories still reach the
judge and are still rejected with reasons, because those rejections are a required feature.

**Judge output was being truncated.** The first live cycle failed with invalid JSON: twelve
rejection entries plus a rationale exceeded the 1200-token output cap mid-string. Raised the
budget to 4096 for judging and added a JSON repair pass that closes an unterminated string and
any open brackets, so a truncated response loses at most its last rejection instead of the whole
cycle. Verified against six truncation modes.

**`lastCycleAt` was reporting the initialization time.** Scheduling and completion shared a single
write, so the field updated when the *next* cycle was scheduled rather than when one actually ran,
and `/trigger` never updated it at all. Split into `setNextCycle()` and `touchLastCycle()`.

**RSS titles arrived HTML-escaped.** Visible in the rejections panel as `Jony Ive&#8217;s`. Titles
from all sources are now entity-decoded at the discovery layer, before they are stored or judged.

**Verification approach.** jsdom could not be used for the UI check — it does not execute
`<script type="module">`, so the React bundle never mounted and every assertion failed. Switched to
headless Chrome via `puppeteer-core` against the already-installed system browser, asserting 14
render checks at a 390px viewport plus the rationale disclosure, the rejections panel, and agent
switching.

---

## 2 — Deployment (2026-08-07)

**Request:** while walking through Render's "New Web Service" form, asked what to fill in.

Render's manual form does not read `render.yaml`, so the values it autofilled had to be
corrected by hand. Two things mattered: the form had preselected the **Starter ($7/month)**
instance rather than Free, and `NODE_VERSION=22.19.0` needed adding alongside `GEMINI_API_KEY`
— `better-sqlite3` is a native module, and pinning the Node version avoids an ABI mismatch
between Render's default runtime and the version the project was built against.

Deployed to **https://vibecode-5t8l.onrender.com** on the free plan. The boot logs confirm the
autonomy wiring independently of any API call:

```
[scheduler] started — tick every 5min, cycle cadence 2-3h, autonomy window 48h
[keepalive] self-ping every 12min -> https://vibecode-5t8l.onrender.com/api/health
```

Live verification: 10/10 API checks (cold start, static frontend, SPA fallback, init, all four
agent endpoints, 404 handling, a full trigger cycle, and feed-shape assertions covering unique
ids, ISO 8601 UTC, newest-first ordering, and rationale/sources presence), plus 14/14 render
checks driven through headless Chrome against the live backend at a 390px viewport, with the
rationale disclosure, rejections panel, and agent switcher all exercised.

Noted while doing this: because the free tier has an ephemeral filesystem, any push that
triggers an auto-redeploy resets `data/store.db`. The README/PROMPTS update was therefore pushed
immediately, while the live instance held only one post, and the demo personas were re-seeded
afterwards so the 48-hour autonomy window starts from a clean deploy rather than being cut short
by a later one.
