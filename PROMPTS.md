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

---

## 3 — Rebuild against the Anthropic spec (2026-08-07)

**Request:** the same product, but to a stricter specification — Anthropic API with
`claude-sonnet-4-6` and the `web_search` tool for discovery, a written-out persona config that
every prompt references, a *separate* judging call per candidate, a memory check against the
last ~20 posts before writing, and an automated voice-consistency review. Plus: analyze how much
progress had already been made.

**What survived.** The architectural half was already right and was kept: the long-lived
Express process, the `node-cron` 5-minute tick against stored due-times, SQLite with WAL, the
two required endpoints, the rejection log, and the React dashboard. The LLM half was built for a
different spec and was replaced wholesale.

**What was replaced.**

- `gemini.js` → `claude.js`. Beyond swapping SDKs this had to handle things the Gemini path
  never did: `stop_reason: "pause_turn"` continuation (a server-tool turn that hits its internal
  iteration limit resumes by re-sending with the assistant turn appended), `stop_reason:
  "refusal"` checked *before* anything reads `response.content`, and error classification via the
  SDK's typed exception classes rather than string-matching messages — so the scheduler can tell
  a rate limit (retry in 10 minutes) from a bad API key (retrying cannot help).
- Discovery: Hacker News + three RSS feeds → one Claude call with the `web_search_20260209`
  server tool. This trades a deterministic source list for live, beat-aware search, and
  introduces a failure mode RSS did not have — a plausible-looking URL that never existed. The
  fix was to check every candidate URL against the URLs the search tool actually returned, then
  *flag* rather than drop the misses, because silently dropping them would starve the feed. The
  judge is told, and an unverifiable source fails the credibility standard on the record.
- Judging: one batched call ranking all candidates → one call per candidate, run concurrently,
  each reasoning on its own merits. A failure in one is caught and skipped rather than taking the
  cycle down.
- The persona: a six-line voice blurb interpolated from `name` + `domain` → `src/persona.json`,
  a full config with bio, six voice dimensions, five covered topics, five avoided ones, three
  recurring positions, and a banned-phrase list. It is stored per agent at init, so a restart
  mid-window resumes with the exact voice it started with.

**Two judgment calls worth recording.**

*Thresholds are enforced in code, not trusted from the model.* The judge returns per-standard
scores and a decision; `judgeCandidate()` then independently checks overall ≥ 70 and no standard
below 40, and overrides a `publish` verdict that does not meet them — logging the override in
the rejection reason. Asking a model to both score and gate is asking it to mark its own work.

*Approved-but-not-published candidates are deferred, not rejected.* With a two-post cap, a good
third candidate is left in neither table, so it resurfaces next cycle. Logging it as a rejection
would have been the easier code and a dishonest record.

**Structured outputs were considered and rejected.** `output_config.format` would remove the
JSON-parsing guesswork entirely, but it is not available on `claude-sonnet-4-6` — the model the
spec mandates. So the JSON contract stays in the prompts, enforced by `parseLooseJSON()`, which
strips markdown fences and repairs objects truncated by the output-token limit by walking cut
points backwards until one parses. Documented in the README as a constraint rather than left as
a silent workaround.

**Verification.** No Anthropic API key was available in the build environment, so the live-LLM
half — real posts, real rejections, the voice check — is the operator's to run. Everything else
was exercised directly: `/init` → `/feed` → `/debug/rejected` → `/persona` shapes, validation and
404 paths, a genuine cold-process restart confirming posts, rejections, `next_cycle_at` and the
48-hour window all survived, and a deliberately keyless cycle confirming the scheduler logs the
failure and keeps ticking. That last test found a real bug: the missing-key error was being
retried because it carried no `retryable` flag. Fixed.

---

## 4 — Back to Gemini for the free tier (2026-08-08)

**Request:** revert the provider to Gemini — the project needs to run on free APIs.

A cost decision, so the provider layer changed and nothing else did. The persona config,
per-candidate judging, memory window, voice check, and every endpoint stayed exactly as they
were; `src/claude.js` was replaced by `src/gemini.js` exporting the same interface
(`complete` / `completeJSON` / `withRetry` / `parseLooseJSON` / `getActiveModel`), so
`discovery.js`, `pipeline.js`, `routes.js` and `voice-check.js` needed only an import swap.

**SDK.** `@google/genai` (v2), not the `@google/generative-ai` package the first build used —
that one is deprecated. Its surface was verified against the shipped typings before any code
was written rather than recalled: `tools: [{ googleSearch: {} }]`, `config.systemInstruction`,
`config.thinkingConfig.thinkingBudget`, `response.text`, and grounding at
`response.candidates[0].groundingMetadata.groundingChunks[].web.{uri,title}`.

**Three things did not port cleanly, and each forced a real change.**

*JSON mode and grounding are mutually exclusive on Gemini.* `responseMimeType:
'application/json'` alongside `tools` is rejected. So the grounded discovery call uses a
prompt-stated JSON contract with `parseLooseJSON()` as the safety net, while the ungrounded
judge and writer calls do use JSON mode. Fragility is confined to the one call that cannot
avoid it.

*Grounding returns redirect URLs, not publisher links.* `web.uri` is a
`vertexaisearch.cloud.google.com/grounding-api-redirect/…` link, so the exact-URL check the
Anthropic build relied on could never match. Verification was rewritten to work on domains,
derived from `web.title` (normally a bare domain) plus the URI host. This is genuinely weaker
— it catches an invented domain but not a real domain with an invented path — and the README
says so under Known constraints instead of leaving the check looking stronger than it is.

*Free-tier quota is a first-class failure mode, not an edge case.* The model fallback chain
from the first build was reinstated (`gemini-2.5-flash` → `gemini-2.0-flash` →
`gemini-2.5-flash-lite`, sticky once one answers), because some AI Studio projects report a
hard `limit: 0` entitlement on an alias that no retry can fix. Beyond that, per-minute and
per-day 429s are now distinguished: a per-minute cap is retryable and reschedules in ten
minutes, a daily cap is marked non-retryable so the loop stops hammering an API that will not
answer until midnight Pacific.

`thinkingConfig` is attached only to 2.5-series models — sending it to `gemini-2.0-flash` is
an error — so the pipeline's abstract `effort` levels map to thinking budgets on 2.5 and are
ignored on the fallback.

`render.yaml` went back to `plan: free` to match the intent, with both free-tier caveats
(sleeping instances, ephemeral disk) documented rather than buried.

**Two incidental defects fixed while here.** `npm --prefix client install` was injecting a
circular `file:..` self-dependency into the client manifest on every build — with a
package.json in the working directory, that form means "install the package here *into* that
prefix". Switched to `cd client && npm install`. And an `npm install` run from a drifted shell
directory created `node_modules/`, `package.json` and `package-lock.json` at the repository
root; all three were removed.

**Verification.** Still no API key, so the live-LLM half remains the operator's to run. The
Gemini layer was unit-checked without one — model chain, `SEARCH_TOOL` shape, JSON fence and
truncation repair, grounding-metadata extraction against the real response shape including the
no-grounding and non-web-chunk cases — and the full server was re-exercised end to end:
`/init`, `/feed`, `/debug/rejected`, `/persona`, the built frontend, SPA fallback, a cold
restart preserving posts and schedule, and a keyless cycle failing without taking the
scheduler down.

---

## 5 — First live runs (2026-08-08)

**Request:** an API key, with instructions to use it.

The key did not match the AI Studio `AIza…` format, so it was tested rather than assumed —
it worked, and grounding worked with it. Every finding below came from running the pipeline
for real, and none of them would have surfaced from code review.

**Run 1 — the cycle worked, then died on the last call.** Discovery returned 4 candidates
from 9 grounded sources, per-candidate judging ran, a 503 was retried and succeeded, three
candidates were rejected and one was approved. Then the write call — the one the whole cycle
exists to make — failed, because six API calls in forty seconds had exhausted the free tier's
per-minute quota. Four defects, each a design flaw rather than a typo:

- *Judging ran concurrently via `Promise.all`.* That is what caused the burst. Cycles are
  hours apart, so parallelism buys nothing and costs the write call. Now sequential, with a
  ~4s floor between all outbound calls.
- *The write call had no retry wrapper.* Discovery and judging both had one; the most
  important call in the cycle was the only unprotected one. Fixed.
- *Retry backoff was 3s against a per-minute quota.* Useless by construction. Now honours the
  server's `retry-after`, falling back to ~35s for rate limits.
- *A 404 named the sticky model rather than the model that failed*, so a dead entry in the
  fallback chain reported itself as a failure of the primary. Fixed, and a permanently-404
  model is now dropped from the chain for the life of the process.

Probing the chain directly explained the rest: `gemini-2.5-flash-lite` returns 404 ("no
longer available to new users") and `gemini-2.0-flash` returns 429 on this key — the
`limit: 0` entitlement problem from the first build, still present. Both were dead entries.
The chain is now `gemini-2.5-flash` → `gemini-3.5-flash` → `gemini-flash-latest`.

**Run 2 — it published, and the sources were unusable.** Two posts, both on-beat and in
voice. But every stored source was a `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
link: opaque, expiring, and worthless to a reader. Grounding never exposes the publisher's URL.

The first fix was wrong in an instructive way. Telling the model to report "the publisher's
canonical URL" instead of the redirect made it *reconstruct* URLs from memory — precisely the
fabrication the verification step exists to catch. Run 3 rejected all four candidates on
credibility, and the acceptance rate went from 2/4 to 0/4.

The redirect was the trustworthy artifact all along. Inverted: the prompt now demands the
redirect *verbatim*, and the code follows it to its destination. That resolves to the real
article **and** is the strongest verification available — a link that resolves provably exists
and is provably what the search returned. The judge's source note was also over-alarming for
what had become the normal case, so it now carries three graded states (confirmed / partly
confirmed / unconfirmed) with an explicit note that partial confirmation is not grounds for
rejection on its own.

**Run 4 — correct.** Two posts published, one rejected, one deferred, all sources real
publisher URLs (`thehackernews.com`, `helpnetsecurity.com`, `csoonline.com`). Corroboration
rose from 1/4 to 3/4 once redirect resolution fed real hosts into the domain check. The model
chain exercised itself for real: `gemini-2.5-flash` hit its per-minute limit and the cycle
completed on `gemini-3.5-flash`.

`npm run voice-check` then passed on live output for the first time — 97 and 99 per-post,
consistency 95/100 — and earned its place by catching something a lint cannot: both posts
close on the same rhetorical move (a superficial fix named, then dismissed as architectural).
That is exactly the drift the check exists to surface.

**One editorial weakness surfaced and is documented rather than fixed.** An early run scored a
story 98 while citing a content-farm domain, because the judge could only see a Google
redirect. Redirect resolution closes that specific hole — the judge now sees the real
publisher — but there is still no reputation signal, so a plausible-looking domain is taken at
face value.

---

## 6 — Expanding the roster (2026-08-08)

**Request:** more agents and topics — history, geography, politics, sports, music.

Five new personas written to the same structure as Ada, who stays (the brief specifies
AI/tech, and she is what satisfies it; the rest are additive). The work that mattered was
making them *different* rather than recolours of one voice: each varies sentence length,
formality, humour, and structure, and each carries its own domain clichés in `bannedPhrases`
so the lint means something specific per persona — Tobias is blocked from "lost to history",
Dario from "clutch gene", Wren from "sonic landscape". A check confirmed all six differ on
every voice axis.

**Politics was scoped deliberately.** An autonomous agent publishing unsupervised political
opinion is a bad idea, so Ellis analyses process and institutional mechanics — electoral
systems, procedure, coalition arithmetic — with advocacy, horse-race prediction, and
personality coverage in the avoid list, plus a post rule forbidding any implied verdict on a
party or candidate.

Persona resolution gained a middle step: name match, then **domain** match, then the fallback
template. `{"name":"Bob","domain":"History"}` now returns Tobias's beat and voice under Bob's
name, which makes the roster reachable without knowing the authored names. `npm run seed`
starts the whole roster in one command.

**Then the quota reality arrived, in two stages.**

Six agents at a fixed 2–3h cadence would have run the daily quota dry partway through day
one, so the scheduler now derives its interval from a shared daily call budget: one agent is
unaffected and stays at 2–3h, six stretch automatically. `/api/agent/status` reports the
cadence actually in effect rather than a constant, because a hardcoded string would now be a
lie.

Seeding the roster then exposed a defect the single-agent case never could: all six priming
cycles fired at the same moment and rate-limited each other, and every one of them failed
discovery. Priming is now staggered by roster position (3 minutes apart by default).

Finally, probing the 429 payload directly gave the number the whole design hinges on:

```
quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
quotaValue: "20"    model: gemini-2.5-flash
```

**Twenty requests per day, per model** — an order of magnitude below the 200-call budget
assumed an hour earlier, and the correction is load-bearing rather than cosmetic. Because the
cap is per *model*, the fallback chain became the capacity strategy rather than mere failover:
it now lists six models, each contributing its own allowance. The budget dropped to 100,
discovery asks for 3–4 candidates instead of 3–5, and the honest conclusion went into the
README: six agents on a free key yields roughly six cycles each over 48 hours, which is a
handful of posts apiece, not a steady stream. Two or three agents, or a paid key, is the
comfortable configuration.

---

## 7 — Persona picker in the UI (2026-08-08)

**Request:** surface the agents in the frontend so a persona can be selected rather than typed.

The init form was still offering three hardcoded presets — `Ada`, `Turing`, `Grace` — two of
which no longer existed. It now fetches `/api/personas`, so `src/persona.json` stays the single
source of truth and the UI cannot drift when a persona is added or renamed. The endpoint was
enriched to carry a tagline, the covers and avoids lists, and the post length.

The design choice worth recording: the picker shows each persona's **avoid list** alongside what
it covers, struck through. The avoid list is what makes these personas distinct from one another
and from a generic writer, and it was previously invisible unless you opened the JSON. Showing
the editorial contract before you commit to starting an agent seemed more useful than another
paragraph of bio. Cards also carry a `running` badge, and preselection skips personas that
already have an agent. The switcher tabs gained the beat under the name, because with six agents
the names alone stopped being distinguishable.

Verified in headless Chrome rather than by inspection: 13 assertions covering card rendering,
names and beats, single preselection, the detail panel updating when a different card is
clicked, the custom option revealing its inputs, and no horizontal overflow at 390px — plus a
second pass with two agents already running to confirm the badges and the preselection skip.
`puppeteer-core` was installed for the check and removed afterwards.

---

## 8 — Two quotas, not one (2026-08-08)

**Request:** a second API key, to carry on after the first ran out.

It did not help, and finding out why produced the most consequential correction so far.

**A second key in the same Google Cloud project shares the same exhausted quota.** Quota is
per project, not per key. The new key returned the same 429 immediately.

Probing the chain then produced a contradiction worth chasing: four of the six models answered
a plain request, yet every one of them failed the pipeline's discovery call. The controlled
test — same model, same key, same minute, with and without `tools: [{googleSearch: {}}]` —
settled it. The plain call succeeded; the grounded call returned 429.

**Google Search grounding is metered separately from text generation, and project-wide rather
than per-model.** Two things follow, and both were wrong in the code:

- The fallback chain cannot rescue a grounded call. Every model draws on the same grounding
  allowance, so walking six models to find one that works is guaranteed to fail — it just takes
  half a minute and six requests to prove it. Grounded 429s are now detected as a distinct
  `GROUNDING_QUOTA` condition and fail immediately.
- The error message was actively misleading. "Daily quota is exhausted for this API key" is
  false when generation is fine and only grounding is out, and it points at the wrong fix. The
  message now says which quota ran out, that no fallback model can help, that judging and
  writing still work, and when it resets.

It also means **grounding, not generation, caps cycles per day** — each cycle makes exactly one
grounded call, so adding models to the chain buys judging and writing headroom but no extra
cycles. The README and `.env.example` now say so, with the knob settings to pace on grounding
directly.

**Not verified:** a live cycle for any of the five new personas. Grounding quota was exhausted
before one could be run, and no configuration change can work around it — it needs either the
midnight Pacific reset or a different Google Cloud project.

---

## 4 — Switch to Pollinations.ai and illustrate the posts (2026-08-08)

**Request:** replace the Gemini key with Pollinations.ai, "which generates texts and image as
well", and make the posts more versatile with good text and images.

### What Pollinations actually provides

Probed before writing any code, because the whole request rests on what the API can do:

| | Result |
|---|---|
| Images (`sana`) | ✅ Free, no key, no signup. Real 1024x640 JPEG in ~1.5s. |
| Text (`openai-fast`) | ❌ `402 PAYMENT_REQUIRED` — *"this request costs ~0.0002 pollen, but this key has 0.0000"* |

The text failure is not a rate limit that clears. Pollinations moved text to a "pollen"
balance and the anonymous balance is exactly zero, so any request that costs anything is
refused. Bisected to be certain: a 6-character prompt succeeds, 200 characters already fails,
and 0/4 realistic pipeline-sized prompts succeeded. Supplying a referrer — in the body, as a
header, and as a query parameter — changed nothing. The `/openai` compatibility path 402s
even where the plain path works.

So "replace Gemini with Pollinations" is only half-possible, and the half that works is the
half that was missing. Rather than swapping text to a provider that fails 100% of real calls,
or stopping to ask:

- **Images moved to Pollinations completely.** Every published post now gets generated
  artwork. Free, no key, no quota — a strict improvement over having no images.
- **Text became a routed choice** (`src/llm.js`). The Pollinations text client is implemented
  and correct, and activates the moment `POLLINATIONS_TOKEN` is set. Until then `auto` keeps
  text on Gemini so the pipeline runs. `/api/agent/status` reports which provider is live.

### Discovery had to stop depending on Gemini

Discovery was one Gemini call with Google Search grounding, which no other provider has —
meaning the text provider was not actually swappable, whatever the router said. Added
`src/feeds.js`: Hacker News plus six RSS feeds, deduplicated across sources and ranked against
the persona's beat. No LLM call, nothing metered, and every URL comes from a real feed
response, so the class of bug the grounded path defends against with redirect resolution and
domain verification cannot occur here. `DISCOVERY_MODE=auto` also falls back to feeds when
grounding quota runs out, so discovery degrades instead of stopping.

### Making posts varied rather than merely longer

"More versatile" was read as structural variety, not more words. A strong voice repeated
across every post still reads as one template. So the voice is held constant and the
*structure* rotates: six formats (analysis, counterpoint, field note, threat model, context,
scrutiny), choosing one unused in the last three posts, with the story's character overriding
the rotation where it should — an unverifiable vendor claim is always read skeptically.

Each post also gained a **takeaway** (the point, not a summary) and a per-story **image
brief**. All three come back from one write call rather than three: the write step runs last,
when the daily quota is already partly spent, and a model that just wrote the post is better
placed to distil it than one told about it second-hand.

### Problems found and fixed

**The image model ignores "no text".** `sana` renders garbled pseudo-text along the bottom
edge even with `nologo=true` and explicit negative prompting — confirmed by inspecting real
output, not assumed. Prompt wording was not going to fix a model-level habit, so artwork is
generated at 1024x640 and rendered into a 16:9 box anchored to the top, cropping the bottom
~10% away deterministically. Verified gone by re-rendering.

**Stale stories were outranking fresh ones.** Feed ranking weighted beat relevance at 2x,
which let a 25-day-old Krebs piece outrank the day's news purely by being more on-topic —
spending a judging call on something the TIMELINESS standard would reject anyway. Anything
past a week is now discounted hard rather than excluded, so a genuinely major older story can
still surface.

**Artwork must never cost a cycle its work.** `attachImage()` runs after the post exists and
cannot throw; a failed or slow image downgrades the post to text-only. Generation is verified
at publish time (real image, over 1KB) so a broken URL is never written into an append-only
feed, and the card removes the element on load failure instead of showing a broken icon.

**A live cycle could not verify any of this.** The judge rejects most real candidates by
design, so a run that publishes nothing is a working run and proves nothing about the write
path — 0/6 published across three attempts, all for legitimate editorial reasons. Added
`npm run image-check`, which drives the real `writePost`/`attachImage` against a fixed
synthetic candidate, so the write-and-illustrate path is testable independently of the day's
news. Rendering was then verified in headless Chrome at 390px: 10/10 checks, images confirmed
loaded at their natural size rather than merely present in the DOM.

Also surfaced during this work: `gemini-2.5-flash` has since become unavailable on this key
and the fallback chain correctly dropped it mid-run and continued on `gemini-3.5-flash`.

---

## 5 — Groq for text, and make the artwork relevant (2026-08-08)

**Request:** switch text generation from Gemini to Groq using a supplied key, and fix the
Pollinations images, which were irrelevant to the posts they sat above.

### Groq

Straightforward and a clear win. Gemini's free tier meters ~20 requests per model per day,
which is what had forced a six-model fallback chain used as a capacity strategy, a daily-call
budget in the scheduler, and cadence stretching. Groq's free tier is per-minute at far higher
volume and roughly 20x faster per call. Measured on the same cycle and candidates: **14
seconds end to end, down from 123.**

`openai/gpt-oss-120b` was made primary over `llama-3.3-70b-versatile` on measured quality, not
size — tested against the same fixed candidate, llama returned a 35-word draft that failed the
length lint and the takeaway *"New browser introduces new risks"*, while gpt-oss-120b cleared
the voice check first pass with *"Runtime sandboxes add a layer, but they don't replace
model-level defenses."* A failed lint costs a regeneration call, so the better model is cheaper.

`groq/compound` advertises built-in web search, which would have restored grounded discovery,
but it rejects even a minimal request with `request_too_large` on this key. Discovery stays on
feeds.

**One non-obvious bug this surfaced.** Groq's models return the judge's scores on a 0-10 scale
where the prompt asks for 0-100 — a verdict of `overall: 8` meaning "excellent" would be read
as 8/100 and rejected. Left alone, every cycle would have become a shutout that looked exactly
like strict editing rather than a scale bug. `normalizeScores()` now detects it by shape (all
scores present and <= 10, at least one non-zero) rather than by provider, so it also protects
against any future model doing the same.

### Making the artwork relevant

The images were handsome and meaningless — a glowing orb above a story on patch triage. Three
distinct causes, found by generating and *looking at* real output rather than reasoning about
the prompt:

**Asking for "abstract" guaranteed irrelevance.** The brief demanded abstract conceptual
imagery, which is an instruction to discard the subject. It now asks for a depicted scene
naming concrete objects, with the story's own nouns and tag prepended as a subject anchor.

**Negations were summoning what they forbade.** Pollinations' URL API has no negative-prompt
field, so "no faces, no people" lands in the positive prompt. A brief ending in exactly that
returned a portrait of a person staring into the camera. Every constraint is now phrased
positively, and `stripNegations()` deterministically removes any "no X" / "without X" /
"avoid X" clause the writing model leaks through.

**Some objects attract text and some do not.** A "steel gate" produced a glowing sign covered
in garbled lettering, centred where the bottom crop cannot reach. Signs, doors, screens,
packaging, dials, and keyboards render with fake writing; cables, locks, circuit boards,
wafers, chains, and mechanisms render cleanly. The brief now steers object choice rather than
adding another negation.

An intermediate attempt overcorrected into "a deserted room" and produced a literal empty
office with the subject absent, so the style contract now specifies a tight close-up where the
objects fill the frame. Verified across three unrelated story types — export controls, supply
chain, patch management — rather than on the single example that motivated the fix.

---

## 6 — An off switch for a running agent (2026-08-08)

**Request:** there was no way to manually stop or pause an agent like Ada once it was
publishing.

A fair gap, and a real one rather than a missing nicety: an agent that publishes unattended for
48 hours with no way to stop it is a design hole. `/trigger` was the only manual control and it
starts work rather than stopping it, so the only options were killing the process or waiting
out the window.

Added `pause`, `resume`, and `stop` as a lifecycle state on the agent row rather than a boolean,
because "paused" (the operator will decide later) and "stopped" (the operator is done) need to
be distinguishable — they render differently and only one is reversible. `stop` also closes the
autonomy window, so it cannot be undone by flipping the state back; the UI confirms before
calling it.

Three decisions that needed thought rather than defaults:

**A cycle already in flight is not aborted.** It holds an open request to the model provider,
and killing it would spend the quota and store nothing. It finishes and writes its result. That
created a visible contradiction in the first version — an amber "paused" pill next to a
countdown reading "now" — so the transition has its own labels: `pausing` and `finishing`.

**`/trigger` is refused while paused.** Allowing it would make "paused" mean "paused unless you
press the button", which is not what an off switch is for.

**Resume reschedules from now when the due time has passed.** An agent paused for six hours
would otherwise fire the instant it resumed, which reads as the pause having been ignored. A due
time still in the future is left alone so a brief pause does not push the schedule back.

The first UI pass passed 13 of 14 browser checks, and the one failure was the code being more
truthful than the test: a cycle genuinely was mid-flight, so "now" was correct. Fixing the
contradiction properly — rather than relaxing the assertion — is what produced the
`pausing`/`finishing` states.

Two inconsistencies only became visible in a screenshot, not in the assertions: the empty state
still read "its autonomous loop is live" with an enabled "Run a cycle now" button under a paused
agent, and the Activity panel ignored the state entirely. Both now reflect it. Verified end to
end in headless Chrome: 14/14 across active → pause → resume → stop, including the confirmation
dialog and the disabled-trigger states.

---

## 7 — Post to a real X (Twitter) account on an interval (2026-08-08)

**Request:** the agent should be able to handle the user's X account, posting a tweet at a
set interval, using credentials the user would provide.

**First correction: not credentials, an API app.** The user offered to paste a username and
password. Declined — driving the web UI with login credentials violates X's Terms of Service,
risks the account being flagged, and would put a real password in a plaintext `.env` file.
Walked through creating an X Developer app instead (console.x.com), including the two gotchas
that catch almost everyone doing this for the first time: App permissions default to
read-only and must be explicitly set to "Read and write" *before* generating tokens, in that
order — tokens generated under the old permission stay read-only even after the setting
changes, so they have to be regenerated afterward, not just the permission changed.

**Credentials authenticated 401, and the cause mattered before writing a line of posting
code.** `GET /2/users/me` returned `401 Unauthorized` with a textbook-correct OAuth 1.0a
signature. Rather than assume the code was wrong, isolated the variables one at a time:
checked the four credential values for invisible/non-ASCII characters from copy-paste (none),
compared the sandbox clock against X's own `Date` response header in case of timestamp drift
(they matched, so not that), then tested the *simplest possible* OAuth 1.0a call —
`POST oauth/request_token` with only the consumer key/secret, no access token involved at
all — which failed identically. That result is diagnostic: it rules out a signature bug or an
access-token mismatch, since neither participates in that call, and points at the account or
project itself. Correlated with what the console had already shown: a "Pay Per Use" plan and a
`$0.00` balance. Conclusion: X's newer billing can reject even nominally-free calls with a bare
401 when a project has no payment method on file — a billing gate wearing an auth error's
clothes. Presented this finding and three options; the user chose to have the integration built
now, in dry-run, and sort billing separately.

**Built as an opt-in per agent, not a global switch.** One X account, several personas — tweeting
everything by default would be a mess of unrelated voices on one timeline. `POST
/api/agent/twitter/enable` turns it on per agent.

**Tweeting is a separate scheduler from the write cycle, not "tweet every post as it
publishes."** A cycle that publishes two posts should not tweet both back to back — spam on a
timeline in a way it is not in a scrolling feed. `scheduler.js` gives tweeting its own due-time
column and its own cadence (`TWEET_MIN_HOURS`–`TWEET_MAX_HOURS`, default 3–5h), and always
promotes the *oldest* un-tweeted post rather than the newest, so a burst reaches the timeline in
publication order instead of the newest jumping the queue.

**Composed from the takeaway, not the post.** A tweet is a pointer to the post, not the post
itself. `composeTweet()` uses the takeaway field that already exists for exactly this, plus the
first source link — with the link's space reserved first (X always counts a URL as 23
characters via t.co, regardless of its real length) and the takeaway trimmed to what is left on
a word boundary.

**Dry run is the default, not a caution for its own sake.** Given the confirmed billing gate,
`TWITTER_DRY_RUN=true` composes and logs exactly what would be posted and records it against the
post — same DB shape, `dryRun: true` — without calling the network. This is what let the entire
pipeline (composition, independent scheduling, per-post recording, the enable/disable UI) be
built and verified end to end despite the account being unable to post for real right now, and
it flips to live with one env var once billing is sorted.

**Failure handling had to distinguish whose failure it is.** A rejection tied to a specific post
(X refuses it as duplicate content) is recorded against that post and the queue moves on — retrying
it forever would never succeed. A rejection tied to the account (bad credentials, a billing gate,
a rate limit) has nothing to do with which post was picked, so the post is left untouched and
eligible, and only an account-level backoff timer applies. Getting this wrong would have meant a
billing problem burning through the whole queue, marking every post permanently failed for a
cause none of them caused.

**One real bug, caught by testing the manual endpoint against a stopped agent.** `POST
/agent/twitter/tweet-now` initially had no lifecycle check and posted successfully from an agent
whose `state` was `stopped` — inconsistent with `/agent/trigger`, which correctly refuses that.
Fixed to mirror it: a stopped or paused agent does nothing autonomous, and a manual button must
not be a backdoor around that, or "stopped" would only mean "stopped writing."

Verified end to end in dry-run: enable/disable, oldest-first queueing across two unposted posts,
empty-queue handling, the lifecycle guard (409 on a stopped agent, confirmed via direct DB
inspection that the *test* — not the code — had accidentally left an agent's autonomy window
closed), and 8/8 checks in headless Chrome covering the panel, the dry-run notice, the tweet
badges on post cards, and the enable/disable toggle round-trip.
