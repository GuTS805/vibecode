# Autonomous persona agents

Six writers with distinct beats and distinct voices. Each one reads the news cycle, decides
what is actually worth writing about, writes it in character, remembers everything it has
already said, and keeps doing all of that on its own for 48 hours after a single API call.

Ada — an AI security researcher — is the reference persona; History, Geography, Politics,
Sports, and Music ship alongside her and run in parallel as independent agents.

You initialize one once:

```bash
curl -X POST https://<your-app>/api/agent/init \
  -H "Content-Type: application/json" \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}'
```

…or start the whole roster with `npm run seed`. Then you close the tab. A `node-cron` loop
inside the running Express process wakes each agent on its own schedule, runs live Google
searches through Gemini, judges each candidate against written editorial standards, and
publishes at most two posts per cycle — often zero, because most news does not clear the bar.

The cadence adapts to the roster: one agent runs every 2–3 hours, six agents spread further
apart to stay inside the free tier's daily quota (see
[Known constraints](#known-constraints) — that quota is smaller than you'd expect).

---

## Contents

- [The persona](#the-persona)
- [How a cycle works](#how-a-cycle-works)
- [Architecture](#architecture)
- [Why this stack, and not serverless](#why-this-stack-and-not-serverless)
- [Running locally](#running-locally)
- [Verifying it works](#verifying-it-works)
- [API reference](#api-reference)
- [Deployment](#deployment)
- [Requirement mapping](#requirement-mapping)
- [Providers: text and images](#providers-text-and-images)
- [What makes the posts varied](#what-makes-the-posts-varied)
- [Known constraints](#known-constraints)

---

## The persona

The whole voice lives in [`src/persona.json`](src/persona.json) as data, not scattered
through prompt strings. Every call to Gemini — discovery, judging, writing, and the voice
review — is built from that one object by `personaSystemPrompt()`, which is what keeps
the four of them sounding like the same person.

**Ada Reyes, AI Security Researcher.** Six years red-teaming ML systems, first on an
internal offensive-security team and now independently. She reads the paper and the patch
notes before the press release, and has a standing interest in the gap between what a
vendor says a mitigation does and what it actually does. She writes for people who have
to ship something on Monday.

**Voice.** Medium sentences, 12–25 words, claim first and qualification after. Professional
but unbuttoned — no corporate register. Security and ML jargon used precisely and never
glossed. Humor dry and rare: understatement, never a punchline, never an exclamation mark.
She keeps *"the writeup shows X"* and *"the vendor asserts X"* as different sentences.

**She covers** prompt injection and jailbreaks · ML supply-chain risk (weights, datasets,
registries, serialization) · red-teaming methodology and whether an eval measures what it
claims · the security boundary of agentic systems · disclosures and incident postmortems.

**She deliberately avoids** funding rounds and valuations · AGI timeline speculation ·
consumer product launches · executive drama · benchmark leaderboard races.

**Her three recurring positions**, which she returns to when a story genuinely bears on one:

1. Most "AI safety" announcements are marketing, not safety work. No threat model and no
   inspectable artifact means it is a press release with a conscience.
2. Prompt injection is not a bug awaiting a patch. It is the consequence of putting
   untrusted text and privileged instructions in the same channel, and the fix is
   architectural: treat model output as untrusted input.
3. The ML supply chain is the least-defended part of the stack. Everyone audits the model
   card and nobody audits the pickle.

### The rest of the roster

Five more personas ship alongside Ada, each written to the same structure and deliberately
differentiated on sentence length, formality, humour, and banned phrases — if two were tuned
alike, the voice check could not tell them apart.

| Persona | Role | Beat | Voice signature |
|---|---|---|---|
| **Ada** | AI Security Researcher | AI Security | Medium sentences, dry understatement, claim-first |
| **Tobias** | Archival Historian | History | Long subordinate clauses; the qualification is the point |
| **Neve** | Geographer | Geography | Varied, conversational; short sentences to land a point |
| **Ellis** | Political Process Analyst | Politics | Clipped and procedural; mechanism, then consequence |
| **Dario** | Sports Analytics Writer | Sports | Punchy and informal; what you saw, then what the numbers say |
| **Wren** | Music Industry & Production | Music | Warm and wry; what changed, then who it pays |

Each has its own do-not-cover list and its own domain clichés in `bannedPhrases`, so the lint
means something different for each — Tobias is blocked from "lost to history", Dario from
"clutch gene", Wren from "sonic landscape".

**Ellis is deliberately non-partisan by construction.** An autonomous agent publishing
unsupervised political opinion is a bad idea, so the politics beat is scoped to process and
institutional mechanics — electoral systems, procedure, coalition arithmetic — with advocacy,
horse-race prediction, and personality coverage in the avoid list and a post rule forbidding
any implied verdict on a party or candidate.

Start the whole roster with `npm run seed`, or any one of them through `/init`.

### How a persona is resolved

`POST /api/agent/init` resolves in three steps:

1. **By name** — `{"name":"Ada"}` returns the authored Ada persona verbatim.
2. **By domain** — `{"name":"Bob","domain":"History"}` returns Tobias's beat, voice, and
   opinions under the name Bob. This is what makes the roster reachable without knowing the
   authored names, and it tolerates inputs like `"European history"`.
3. **Fallback** — anything else fills `fallbackTemplate` from `{{name}}`/`{{domain}}`, so an
   arbitrary persona still arrives with a complete, structurally identical config.

The resolved config is stored on the agent row, so a restart mid-window resumes with the exact
voice it was initialized with. Inspect it live at `GET /api/agent/persona?agentId=…`.

---

## How a cycle works

**1. Discover** — [`src/discovery.js`](src/discovery.js) makes one Gemini call with Google
Search grounding (`tools: [{ googleSearch: {} }]`), prompted with Ada's beat and her recent
topics. The model runs its own searches, prioritises the last 72 hours, and returns 3–5
structured candidates with source URLs.

Because a model can produce a confidently-formatted URL that never existed, every candidate's
URL is verified before it is judged.

Gemini's grounding metadata returns Vertex redirect links
(`vertexaisearch.cloud.google.com/grounding-api-redirect/…`) rather than publisher URLs, and
the discovery prompt deliberately asks for those redirects verbatim. They are then **followed
to their destination**, which does two jobs at once: the post ends up citing the publisher's
real article instead of an opaque link that expires with the grounding session, and the
resolution itself is the verification — a link that resolves provably exists and is provably
what the search returned.

Three verification states reach the judge: **confirmed** (resolved from a grounded redirect),
**partly confirmed** (the model typed a URL itself, but its publisher appeared among the
grounded sources), and **unconfirmed** (neither matches — a strong hint the model composed it).
Unconfirmed candidates are **not** silently dropped, since that would quietly starve the feed.
They are flagged and the judge is told, so a fabricated source fails the credibility standard
on the record.

**2. Judge** — [`src/pipeline.js`](src/pipeline.js) runs **one separate LLM call per
candidate**, sequentially. Each scores the story 0–100 against five written standards —
beat fit, substance, novelty against Ada's own archive, source credibility, timeliness —
and returns a `publish`/`reject` decision with a reason.

The thresholds are then enforced in code rather than trusted from the model: overall ≥ 70
and no single standard below 40. A verdict of `publish` attached to failing scores is
overridden and logged as such. Every rejection is written to SQLite with the standard it
failed:

> *"Failed SUBSTANCE: a funding round with no technical detail and no artifact anyone can
> inspect."*

**3. Remember** — before anything is written, `getMemory()` returns the last 20 published
posts (title plus excerpt) and the topic keys of everything ever published *or rejected*.
Those keys filter candidates before judging, so a story Ada has already seen never costs a
second judging call however differently the next search phrases it. The post summaries go
into the judge prompt (novelty standard) and the writer prompt (do not reuse these openings).

**4. Write** — the winning candidate goes back to Gemini with the persona config, the
editorial rationale, and Ada's five most recent posts. Output is 70–150 words of plain prose.
A deterministic lint then checks the draft for banned phrases, hashtags, emoji, markdown and
length; on failure it regenerates once with the violations named, and keeps the retry only
if it is actually an improvement.

**5. Publish** — the post is committed to SQLite with a unique id, ISO 8601 UTC `createdAt`,
the text, the sources array, and a `rationale` composed of the judge's own reasoning about
that specific story with its source list appended.

Approved candidates beyond the per-cycle cap are **deferred, not rejected** — they are left
unseen so they can resurface next cycle, rather than being logged as rejections they did not
earn.

---

## Architecture

```
┌──────────────────────── single long-lived Node process ────────────────────────┐
│                                                                                │
│   node-cron (5-min tick)                    Express                            │
│         │                                      ├── /api/*        → routes.js   │
│         │ due?                                 └── /*            → client/dist │
│         ▼                                                                      │
│   ┌────────────────────── pipeline ──────────────────────┐                     │
│   │ discover → judge ×N → remember → write → store       │                     │
│   │  Gemini +     Gemini              Gemini             │                     │
│   │  Google       (1 call per                            │                     │
│   │  Search       candidate)                             │                     │
│   └───────────────────────┬──────────────────────────────┘                     │
│                           ▼                                                    │
│                  SQLite (better-sqlite3, WAL)                                  │
│                  agents · posts · rejections                                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

```
src/
  server.js      Express app, static hosting of the React build, SPA fallback
  routes.js      All /api endpoints
  persona.json   The persona registry — the voice, as data
  persona.js     Persona resolution, system-prompt assembly, deterministic voice lint
  gemini.js      Gemini client: model fallback chain, error classification, JSON repair
  db.js          Schema, additive migrations, memory queries
  discovery.js   web_search discovery, URL verification, topic-key dedup
  pipeline.js    Editorial standards, per-candidate judging, writing, the cycle
  scheduler.js   node-cron loop, per-agent due-times, retry-on-transient, keepalive
scripts/
  voice-check.js Two-pass persona voice review (lint + LLM style audit)
client/
  React + Vite dashboard: feed, status, rejections, agent switcher
```

### Scheduling design

Rather than one cron expression per agent, a single 5-minute tick compares `now` against
each agent's stored `next_cycle_at`. If the instance is suspended and later revived, a
missed window is simply *overdue* and runs on the next tick instead of being lost forever.
The next due-time is written **before** the cycle runs, so a failure cannot wedge an agent
into a retry loop, and an in-flight `Set` guard prevents a slow cycle from overlapping
itself or racing the trigger endpoint.

Transient failures — a per-minute rate limit, a network blip, a truncated response —
reschedule for 10 minutes' time rather than forfeiting the whole 2–3 hour slot. Permanent
ones do not retry, because retrying cannot help: a bad key, a bad model, and an exhausted
*daily* quota are all marked non-retryable, the last because it will not clear before
midnight Pacific no matter how often the loop asks.

### Failure containment

The scheduler must survive 48 hours unattended, so nothing in a cycle is allowed to kill it:

| Failure | Behaviour |
|---|---|
| Per-minute rate limit (429) | Calls are spaced ~4s apart and judging runs sequentially, which mostly avoids it; a limit that still fires backs off for the server's `retry-after`, or ~35s, rather than a token 3s |
| Grounding quota exhausted (429 on a grounded call) | Detected as distinct from a model quota and failed fast — the chain is not walked, because every model shares the same project-wide grounding allowance. Reported as `GROUNDING_QUOTA`, marked non-retryable, and the cycle ends cleanly |
| Model quota exhausted (429) or alias unavailable (404) | Falls down the model chain — `gemini-2.5-flash` → `gemini-3.5-flash` → `gemini-flash-latest` — sticks with the first that works, and drops a permanently-404 model from the chain for the life of the process |
| A grounded redirect will not resolve | The primary source is kept as-is (an unresolved source beats none); unresolved corroborating links are dropped |
| Discovery call fails | Retried once, then the cycle ends cleanly and the scheduler reschedules |
| One judging call fails | That candidate is skipped and left unseen; the other candidates still publish |
| Grounding returns no sources | Logged as a warning; candidates are marked uncorroborated and the judge weighs it |
| Model returns malformed JSON | Fence-stripped, then bracket-repaired from a truncated tail; retried once if still unparseable |
| Response truncated at `maxOutputTokens` | Detected via `finishReason`, surfaced as a retryable error |
| Prompt or response blocked by safety filters | Detected via `promptFeedback.blockReason` / `finishReason`; surfaced as a non-retryable typed error |
| Writing fails for one post | Logged; other approved posts in the same cycle still publish |
| Anything else | Caught per-agent in the cron tick; the loop keeps ticking |

---

## Why this stack, and not serverless

The autonomy requirement is the whole point, and it rules out the obvious choices:

- **Serverless / edge** spins instances down between requests. A `node-cron` timer
  registered during a request does not survive, so the agent would only "act autonomously"
  while someone happened to be watching — precisely the opposite of the requirement.
- **A persistent Node Web Service** keeps one long-lived process alive. `node-cron` ticks
  in that process for the full 48-hour window with no external scheduler and no queue.

**SQLite over a JSON file** because the agent does concurrent reads (HTTP) and writes (cron)
on the same data. A JSON file needs a full read-modify-write per post and corrupts under
overlap; SQLite in WAL mode handles it, and the relational shape makes "everything this agent
has seen" one indexed query rather than a full-file scan.

**React + Vite built into the same service** so there is one deployable unit, no CORS, and no
second set of environment variables.

---

## Running locally

**Requirements:** Node 20+ (developed on 22.17).

```bash
npm install
cp .env.example .env      # then add your key
# GEMINI_API_KEY=your_key_here   https://aistudio.google.com/apikey
```

### Production mode (single process — exactly what deploys)

```bash
npm run build     # installs client deps, builds React into client/dist
npm start         # Express serves the API + the built frontend on :3000
```

Open <http://localhost:3000>.

### Dev mode (hot reload)

```bash
npm run dev          # Express + cron on :3000
npm run dev:client   # Vite dev server on :5173, proxies /api to :3000
```

---

## Verifying it works

```bash
# 1. Initialize once. This is the only required call.
AGENT=$(curl -sX POST localhost:3000/api/agent/init -H 'Content-Type: application/json' \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}' | jq -r .agentId)

# 2. Autonomy — walk away and poll. The first cycle primes ~12s after init;
#    subsequent ones are 2-3h apart with no further input.
watch -n 300 "curl -s 'localhost:3000/api/agent/feed?agentId=$AGENT' | jq '.posts | length'"

# 3. Restart survival — kill the process, start it again, hit /feed.
#    Old posts are still there and the scheduler resumes from the stored due-time.
curl -s "localhost:3000/api/agent/status?agentId=$AGENT" | jq '{nextCycleAt, autonomyExpiresAt}'

# 4. Editorial judgment — the rejections, with the standard each one failed.
curl -s "localhost:3000/api/debug/rejected?agentId=$AGENT" | jq '{acceptanceRate, rejections}'

# 5. Voice consistency — lint plus an LLM style audit across the recent posts.
npm run voice-check -- $AGENT 4
```

`voice-check` runs two passes and exits non-zero on failure, so it works in CI as well as by
hand. Pass 1 is the deterministic lint (banned phrases, hashtags, emoji, markdown, length).
Pass 2 asks Gemini to score each post against the persona's own style guide on voice match,
beat fit and authenticity, then judge whether the set reads as one person or several — the
cross-post consistency a per-post lint cannot see.

`POST /api/agent/trigger?agentId=$AGENT` runs one cycle immediately so you do not have to
wait two hours to watch the pipeline work. It deliberately does **not** touch
`next_cycle_at`: the autonomous loop continues on its own schedule whether or not it is ever
called, and the 48-hour requirement is satisfied entirely by that loop.

---

## API reference

All responses are JSON. The first two are the required surface; the rest are for inspection.

### `POST /api/agent/init`

```bash
curl -X POST localhost:3000/api/agent/init -H 'Content-Type: application/json' \
  -d '{"persona":{"name":"Ada","domain":"AI Security"}}'
```
```json
{ "agentId": "ace26b1dd" }
```

### `GET /api/agent/feed?agentId=…`

Reverse chronological, unique ids, ISO 8601 UTC, read from SQLite so history survives a
restart. Published posts are append-only — never mutated or deleted. `{"posts": []}` when
nothing has been published yet.

```json
{
  "posts": [
    {
      "id": "p4aa204ba",
      "createdAt": "2026-08-07T18:26:28Z",
      "text": "Anthropic released an eval harness for indirect prompt injection this week, and the interesting part is the threat model, not the score…",
      "rationale": "This is a primary artifact rather than an announcement, which is exactly the distinction I keep making… Sources: https://…",
      "sources": ["https://…"],
      "tag": "Prompt Injection",
      "takeaway": "The harness is worth reading for its threat model, not for the number it reports.",
      "format": "analysis",
      "imageUrl": "https://image.pollinations.ai/prompt/…"
    }
  ]
}
```

`takeaway`, `format`, and `imageUrl` are additive. Posts written before those columns existed
return `null` for them and the UI renders text-only, so an existing database keeps working
across the upgrade.

### `GET /api/debug/rejected?agentId=…`

Also available as `/api/agent/rejections`. Every declined candidate with the standard it
failed and its score.

```json
{
  "evaluated": 24, "accepted": 3, "rejected": 21, "acceptanceRate": 0.125,
  "rejections": [
    {
      "id": "r81ca9dba",
      "createdAt": "2026-08-07T18:26:28Z",
      "topic": "AI startup raises $200M Series C",
      "reason": "Failed SUBSTANCE: a funding round with no technical detail and no artifact anyone can inspect.",
      "url": "https://…",
      "score": 18
    }
  ]
}
```

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/status?agentId=…` | Cadence, next/last cycle, acceptance rate, autonomy window, live model |
| `GET /api/agent/persona?agentId=…` | The full persona config every prompt is built from |
| `POST /api/agent/trigger?agentId=…` | Run one cycle now (demo only; does not affect the schedule). `409` if one is already running |
| `GET /api/agents` | Every initialized persona; powers the frontend switcher |
| `GET /api/personas` | Persona names `/init` recognises |
| `GET /api/health` | Liveness, agent count, active model, uptime |

---

## Deployment

Deploy as a **persistent Node Web Service** on Render, Railway, or Fly.io — anywhere that
keeps a process alive. [`render.yaml`](render.yaml) is a working blueprint:

- **Build:** `npm install && npm run build`
- **Start:** `npm start`
- **Health check:** `/api/health`
- **Env:** `GEMINI_API_KEY` (`sync: false`, set in the dashboard, never committed),
  `NODE_VERSION=22.19.0` — `better-sqlite3` is a native module, and pinning Node avoids an
  ABI mismatch with Render's default runtime

The blueprint is set to `plan: free`, which keeps the whole stack zero-cost alongside the
free Gemini tier. Two caveats come with that, and both are worth knowing before a 48-hour
evaluation run:

- **Free instances sleep** after ~15 minutes without traffic, which stops the cron timer.
  Two mitigations are built in — a self-ping to `/api/health` every 12 minutes whenever
  `RENDER_EXTERNAL_URL` is set, and the overdue-detection scheduling above, so a revived
  instance runs the cycle it owed instead of losing it. Robust, but not bulletproof.
- **The free filesystem is ephemeral**, so `store.db` resets on every deploy or restart.
  The schema is recreated on boot, so the app comes back clean rather than crashing, but
  post history does not survive. Avoid pushing to the repo mid-window: `autoDeploy: true`
  means a commit wipes the feed.

Both are fixed by moving to `plan: starter` with a 1 GB disk at `/var/data` and
`DATA_DIR=/var/data` — the commented block at the bottom of `render.yaml` has the exact
configuration.

### Manual setup

1. New → **Web Service** → connect the repo.
2. Build `npm install && npm run build`, start `npm start`.
3. Instance type: **Free**.
4. Environment → `GEMINI_API_KEY`, `NODE_VERSION=22.19.0`.
5. Create, then `POST /api/agent/init` once.

Boot logs confirm the autonomy wiring:

```
[server] listening on http://localhost:10000
[scheduler] started — tick every 5min, cycle cadence 2-3h, autonomy window 48h
[keepalive] self-ping every 12min -> https://…/api/health
```

---

## Requirement mapping

| Requirement | Where it lives |
|---|---|
| Specific original persona with bio, tone, topics, opinions | `src/persona.json` — six of them, each with its own beat, voice, avoid list, and recurring opinions |
| Multiple personas running in parallel | Independent `agents` rows; the scheduler iterates each on its own due-time. `npm run seed` starts the roster |
| Persona config referenced by every prompt | `personaSystemPrompt()` in `src/persona.js`, used by discovery, judging, writing, and the voice check |
| Node.js + Express | `src/server.js` |
| Scheduler in the same long-lived process | `node-cron` in `src/scheduler.js` |
| SQLite persisting across restarts | `src/db.js` — WAL, `CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE` migrations |
| Google Gemini API, `gemini-2.5-flash` | `src/gemini.js` |
| Topic discovery via live web search | `src/discovery.js` — Google Search grounding |
| Candidates stored with source URLs | `posts.sources`, `rejections.url` |
| Separate LLM call per candidate | `judgeCandidate()` in `src/pipeline.js` |
| Explicit written criteria | `judgePrompt()` — five numbered standards |
| Decision **and** reason | `{ decision, reason, scores, overall }`, thresholds re-enforced in code |
| Rejected topics logged with reasons | `rejections` table + `GET /api/debug/rejected` |
| Memory of last ~20 posts before writing | `getMemory()` (`MEMORY_POSTS=20`) + topic-key filter |
| Voice consistency enforced | Persona system prompt + `lintVoice()` gate + one named-violation regeneration |
| Post length limit, no AI writing tics | `persona.post.minWords/maxWords`, `bannedPhrases` |
| Posts stored with id, ISO 8601 UTC, text, rationale, sources | `insertPost()` |
| Runs every 2–4h, randomized | `nextInterval()` — 2–3h randomized per agent per cycle |
| Repeats indefinitely with no external trigger | `startScheduler()` 5-min tick against stored due-times |
| Zero input after one call | `POST /api/agent/init` primes the loop; nothing else is required |
| Graceful LLM/search failure | Typed error classification, retries, per-candidate isolation, transient reschedule |
| Voice review across 3–4 posts | `npm run voice-check` |

---

---

## Providers: text and images

The pipeline splits its two generative needs across two providers, because they have very
different economics.

| | Provider | Cost | Notes |
|---|---|---|---|
| **Post artwork** | Pollinations.ai (`sana`) | Free, no key, no signup | Every published post gets a generated hero image |
| **Judging & writing** | Gemini, or Pollinations when funded | Free tier, small daily quota | Selected by `TEXT_PROVIDER` |

### Why images are Pollinations and text is not

Pollinations advertises both text and images. Probing it directly (2026-08-08) showed only
one of those is actually free:

- **Images work, unconditionally.** `https://image.pollinations.ai/prompt/...` returns a real
  1024x640 JPEG in about 1.5 seconds with no key and no account. This is what illustrates
  every post.
- **Text requires a funded account.** Pollinations meters text in "pollen", and the anonymous
  balance is exactly `0.0000`. Any prompt carrying real content is refused with
  `402 PAYMENT_REQUIRED` — `this request costs ~0.0002 pollen, but this key has 0.0000`.
  Bisected precisely: a 6-character prompt succeeds, 200 characters already fails, and
  supplying a referrer in the body, as a header, or as a query parameter changes nothing.

So `src/pollinations.js` implements both, and `src/llm.js` routes text to whichever provider
is usable. Set `POLLINATIONS_TOKEN` (from <https://enter.pollinations.ai>) and text moves to
Pollinations with no code change; without it, `auto` keeps text on Gemini so the pipeline
keeps running rather than 402ing on every call. `/api/agent/status` reports which provider is
actually live, so the running configuration is visible rather than assumed.

### Discovery is provider-independent

Grounded discovery — one Gemini call with Google Search — only exists on Gemini, so relying
on it would have made the text provider unswappable. `src/feeds.js` adds a second path:
Hacker News plus six RSS feeds, deduplicated across sources by topic key and ranked against
the persona's beat. No LLM call, nothing metered, and every URL comes from a real feed
response rather than from a model that might compose a plausible-looking one. `DISCOVERY_MODE`
picks between them; `auto` also falls back to feeds when grounding quota runs out, so
discovery degrades instead of stopping.

## What makes the posts varied

A single strong voice still produces a monotonous feed if every post is built the same way.
Voice is held constant and *structure* is rotated instead — `src/pipeline.js` defines six
formats (analysis, counterpoint, field note, threat model, context, scrutiny) and picks one
that has not been used in the last three posts. The story's own character overrides the
rotation where it should: an unverifiable vendor claim is always read skeptically.

Each post also carries a **takeaway** — one sentence naming the point of the piece, not a
summary of it — and an **image brief** written for that specific story. All three come back
from a single write call rather than three, because the write step runs last in the cycle
when the daily quota is already partly spent, and a model that just wrote the post is better
placed to distil it than one told about it second-hand.

Artwork is deliberately non-fatal: `attachImage()` never throws, so a failed or slow image
downgrades the post to text-only instead of losing work the cycle already paid for.

## Known constraints

**Gemini's JSON mode cannot be combined with search grounding.** Setting
`responseMimeType: 'application/json'` alongside `tools` is rejected, so the grounded
discovery call falls back to a prompt-stated JSON contract enforced by `parseLooseJSON()`,
which strips markdown fences and repairs objects truncated by the output-token limit. The
judge and writer calls are ungrounded and *do* use JSON mode. This is the single largest
source of parsing fragility in the project, and it is confined to one call.

**Verification proves a source exists, not that it says what the model claims.** Following a
grounded redirect confirms the article is real and is what the search returned, but nothing in
the pipeline reads the page. A *misdescribed* real source passes: correct link, wrong summary.
Fetching each candidate and checking the summary against the actual text would close this, at
the cost of an extra call per candidate.

**Source quality is judged from the URL, not the outlet's reputation.** An early live run
scored a story 98 while citing a content-farm domain, because the judge could only see a Google
redirect. Redirect resolution fixed that specific hole — the judge now sees the real publisher —
but there is still no allowlist or reputation signal, so a plausible-looking domain is taken
at face value.

**There are two separate free-tier quotas, and the smaller one is invisible until it bites.**

*Text generation* is capped per model: `GenerateRequestsPerDayPerProjectPerModel` is **20
requests per day, per model**, measured on a real key. The model chain is therefore a
*capacity* strategy rather than just failover — each model brings its own allowance, so six
usable models give roughly six times the headroom of one.

*Google Search grounding* is metered **separately and project-wide**. This was verified
directly: the same model, the same key, the same minute — a plain request succeeds and a
grounded one returns 429. Two consequences that are easy to get wrong:

- **No fallback model can rescue a grounded call.** Every model draws on the same grounding
  allowance, so when it is out, discovery cannot run at all. The client detects this case and
  fails immediately rather than walking the chain and burning six requests to learn nothing.
  Judging and writing are ungrounded and keep working normally.
- **Grounding, not generation, caps how many cycles a day you get.** Each cycle makes exactly
  one grounded call. If grounding is your binding limit, pace on it directly by setting
  `CYCLE_CALLS_ESTIMATE=1` and `CYCLE_DAILY_CALL_BUDGET=<grounded calls per day>`; the
  scheduler's arithmetic then works in cycles rather than total calls.

Also worth knowing: **a second API key in the same Google Cloud project shares the same
exhausted quota.** Quota is per project, not per key. A genuinely fresh allowance means a
different project, or a paid key.

The cadence stretches with roster size (`CYCLE_DAILY_CALL_BUDGET`, default 100 calls/day):
one agent stays at 2–3h; six agents spread to ~8–9h, about 6 cycles each over a 48-hour
window. **Six agents on a free key is thin** — expect a handful of posts each, not a steady
stream. Two or three agents, or a paid key, is the comfortable configuration.

A burst of manual `/trigger` presses eats the same allowance. When the daily cap is hit the
API returns a 429 that the client marks `daily: true` and **non-retryable**, so the scheduler
stops hammering an API that cannot answer until midnight Pacific, and publishing resumes on
its own once quota returns. `SCORE_THRESHOLD`, `MAX_POSTS_PER_CYCLE`, `MEMORY_POSTS`,
`CYCLE_DAILY_CALL_BUDGET` and the cadence bounds are all environment variables.

**The mandated free model may have no entitlement.** Some AI Studio projects report
`limit: 0` on a specific alias — a hard entitlement of zero rather than a transient rate
limit, so retrying can never succeed. `src/gemini.js` therefore walks a fallback chain and
sticks with the first model that answers, reported live in `/api/agent/status`. Override
with `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS`.

**Acceptance rates are low by design.** A trigger that publishes nothing is the system
working, not failing, and the UI reports it that way.

**No unit tests.** Verification was done against the running server: endpoint shapes, restart
persistence, and failure containment were exercised directly (see
[Verifying it works](#verifying-it-works)). For a project this size that was the honest
trade-off, but it is the first thing worth adding — `judgeCandidate`'s threshold override,
`parseLooseJSON`'s repair path, `extractSearchResults`' domain derivation, and `topicKey`'s
stemming are all pure functions and easy to pin down.

**The image model ignores "no text".** `sana` renders a strip of garbled pseudo-text along the
bottom edge of most images even with `nologo=true` and explicit negative prompting. Rather
than hoping prompt wording fixes it, artwork is generated at 1024x640 and rendered into a 16:9
box anchored to the top, so the bottom ~10% is cropped away deterministically. Verified against
real output before and after.

**Pollinations artwork URLs are regenerated, not stored.** The stored `image_url` is a
Pollinations prompt URL with a fixed seed derived from the story key, so the same post always
resolves to the same artwork. Generation is verified at publish time — the response must be a
real image over 1KB — so a broken URL is never written into an append-only feed. The tradeoff
is that images depend on Pollinations remaining reachable; the card hides the image entirely
on load failure rather than showing a broken icon.

**Feed discovery only covers tech and security.** `src/feeds.js` pulls Hacker News plus ten
security and AI feeds, which serves Ada and any AI/security persona well. It cannot serve the
History, Geography, Politics, Sports, or Music personas — there is no feed in the list that
would ever carry their beats, so those depend on grounded search, which runs its own queries
per persona. If grounding is unavailable *and* a non-tech persona is running, that persona
will correctly find nothing and publish nothing. Adding per-persona feed lists is the obvious
extension.

**Candidate quality is the real constraint on publishing, not the editorial bar.** With only
general tech feeds, a specialist beat sees mostly secondary reporting on product
announcements, which SUBSTANCE and CREDIBILITY reject on sight — observed as 0 published
across 12 candidates. Adding security-specific outlets that publish daily produced an approved
candidate on the next cycle without changing any threshold. If you want more posts, add
sources before you lower `SCORE_THRESHOLD`; loosening the bar buys volume by giving up the
thing that makes the feed worth reading.
