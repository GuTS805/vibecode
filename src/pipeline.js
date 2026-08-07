import { discoverTopics } from './discovery.js';
import { generateJSON, generate } from './gemini.js';
import { getMemory, insertPost, insertRejection, getAgent } from './db.js';

/** How many candidates the judge sees per cycle. Keeps token use inside the free tier. */
const CANDIDATES_PER_CYCLE = 12;

/** Terms that make a story plausibly relevant to any AI/tech beat. */
const DOMAIN_HINTS = /\b(ai|llm|model|gpt|openai|anthropic|claude|gemini|neural|ml|agent|chatbot|inference|training|dataset|transformer|nvidia|gpu|chip|compute|algorithm|automation|robot)\b/i;

const tokenize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);

/**
 * Cheap, deterministic pre-ranking so each persona's candidate pool actually contains
 * stories from its beat. Without this, a niche beat can receive twelve freshest-but-
 * unrelated headlines and correctly reject all of them, publishing nothing for hours.
 *
 * This only orders the pool — it never rejects. Off-beat stories still reach the judge
 * (and are still rejected with reasons), which is the intended editorial behaviour.
 */
function rankForAgent(candidates, domain) {
  const domainTokens = new Set(tokenize(domain));
  return [...candidates]
    .map((c) => {
      const title = c.title;
      const titleTokens = tokenize(title);
      const overlap = titleTokens.filter((t) => domainTokens.has(t)).length;
      const relevance = Math.min(1, overlap * 0.4) + (DOMAIN_HINTS.test(title) ? 0.35 : 0);
      // Relevance dominates, freshness breaks ties, multi-source coverage nudges up.
      const score = relevance * 2 + c.freshness + Math.min(c.alsoSeenIn.length, 2) * 0.15;
      return { ...c, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}

export function buildPersonaPrompt({ name, domain }) {
  return `You are ${name}, an autonomous writer and analyst whose beat is "${domain}".

Voice:
- Confident, specific, and technically literate. You write for practitioners, not a general audience.
- You lead with the actual claim, never with throat-clearing like "In today's fast-paced world".
- You reference concrete mechanisms, numbers, and named systems when the source supports it.
- You are willing to be skeptical. Hype is a thing you push back on, not repeat.
- No hashtags. No emoji. No "Thread 🧵". You are writing a short analytical post, not a marketing blurb.`;
}

/* ----------------------------------- judge ---------------------------------- */

function judgePrompt(agent, candidates, memory) {
  const already = memory.publishedSummaries.length
    ? memory.publishedSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(nothing published yet — this is the first cycle)';

  const list = candidates
    .map(
      (c, i) =>
        `[${i}] "${c.title}"
     source: ${c.source}${c.alsoSeenIn.length ? ` (also covered by: ${c.alsoSeenIn.join(', ')})` : ''}
     age: ${c.ageHours}h old | freshness score: ${c.freshness} (1.0 = brand new, 0 = 72h+ old)
     url: ${c.url}`
    )
    .join('\n\n');

  return `${agent.persona_prompt}

You are deciding what to write about next. Below are ${candidates.length} candidate stories discovered from live sources.

YOU HAVE ALREADY PUBLISHED THESE POSTS — do not repeat, rehash, or write a follow-up that adds nothing:
${already}

CANDIDATES:
${list}

EDITORIAL STANDARDS — apply these strictly. Rejecting most candidates is the correct outcome:
1. RELEVANCE: it must genuinely sit inside your beat, "${agent.domain}". A story that is merely
   "technology" is NOT automatically in your beat. Reject off-beat stories explicitly.
2. SUBSTANCE: there must be a real development — a launch, a result, an incident, a policy shift,
   a technical disclosure. Reject opinion churn, listicles, funding-round noise with no product
   detail, and "X is coming" speculation.
3. NON-REPETITION: reject anything substantially covered by your published posts above.
4. FRESHNESS: weigh the freshness score. A 2h-old development beats a 60h-old one. A low-freshness
   story needs to be genuinely important to survive. State this reasoning explicitly.
5. You may select AT MOST ONE winner. If nothing clears the bar, select none — that is a valid,
   and often correct, outcome.

Return ONLY JSON in exactly this shape:
{
  "selected": <index of the winning candidate, or null if none clear the bar>,
  "rationale": "<2-4 sentences: why this topic, why it matters NOW (reference its freshness/age explicitly), and why you chose it over the other candidates. If null, explain why the whole batch failed.>",
  "tag": "<1-2 word category chip, e.g. 'Model Release', 'Security', 'Policy', 'Infrastructure'>",
  "rejections": [
    { "index": <int>, "reason": "<one specific sentence naming which standard it failed and why>" }
  ]
}
Include a rejection entry for EVERY candidate you did not select.`;
}

/* ----------------------------------- write ---------------------------------- */

function writePrompt(agent, topic, rationale) {
  return `${agent.persona_prompt}

Write your next post about this story:

TITLE: ${topic.title}
SOURCE: ${topic.source}${topic.alsoSeenIn.length ? ` (also covered by ${topic.alsoSeenIn.join(', ')})` : ''}
URL: ${topic.url}
AGE: ${topic.ageHours} hours old

Your editorial reasoning for picking it: ${rationale}

Requirements:
- 90-160 words. One tight, self-contained analytical post.
- Open with the substantive claim. No preamble, no "Let's dive in".
- Include your own read on WHY it matters to someone working in ${agent.domain} — not just a summary.
- If the story is thin or the claim is unverified, say so plainly rather than inflating it.
- Plain prose. No hashtags, no emoji, no markdown headers, no bullet lists.
- Do not invent facts, numbers, or quotes that are not implied by the title and source.

Return only the post text itself.`;
}

/* --------------------------------- the cycle -------------------------------- */

/**
 * One full discover -> judge -> write -> store cycle.
 * Identical code path whether fired by node-cron or by POST /api/agent/trigger.
 */
export async function runCycle(agentId, { trigger = 'cron' } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const started = Date.now();
  console.log(`[cycle:${trigger}] ${agent.name} (${agentId}) starting`);

  const memory = getMemory(agentId);
  const all = await discoverTopics();

  // Memory filter: never re-judge a story this agent has already published or rejected.
  const fresh = all.filter((t) => !memory.seenKeys.has(t.key));
  const candidates = rankForAgent(fresh, agent.domain).slice(0, CANDIDATES_PER_CYCLE);

  if (!candidates.length) {
    console.log(`[cycle:${trigger}] no unseen topics (${all.length} discovered, all previously seen)`);
    return { published: null, rejected: 0, evaluated: 0, reason: 'no-unseen-topics' };
  }

  // Generous token budget: the verdict carries a rationale plus one entry per rejected candidate.
  const verdict = await generateJSON(judgePrompt(agent, candidates, memory), {
    temperature: 0.4,
    maxOutputTokens: 4096,
  });

  // Persist every rejection with its reason.
  let rejectedCount = 0;
  for (const r of verdict.rejections || []) {
    const c = candidates[r.index];
    if (!c) continue;
    if (verdict.selected !== null && r.index === verdict.selected) continue;
    insertRejection({ agentId, topic: c.title, reason: r.reason, topicKey: c.key });
    rejectedCount++;
  }

  const sel = verdict.selected;
  if (sel === null || sel === undefined || !candidates[sel]) {
    // Nothing cleared the bar — a legitimate editorial outcome, not a failure.
    console.log(`[cycle:${trigger}] no topic cleared the bar (${rejectedCount} rejected)`);
    return { published: null, rejected: rejectedCount, evaluated: candidates.length, reason: 'nothing-cleared-bar' };
  }

  const topic = candidates[sel];
  const text = (await generate(writePrompt(agent, topic, verdict.rationale), { temperature: 0.9 })).trim();

  const sources = [topic.url];
  const postId = insertPost({
    agentId,
    text,
    rationale: verdict.rationale,
    sources,
    topicKey: topic.key,
    tag: verdict.tag || null,
  });

  console.log(
    `[cycle:${trigger}] published ${postId} "${topic.title.slice(0, 50)}" ` +
      `(${rejectedCount} rejected, ${Date.now() - started}ms)`
  );

  return {
    published: { id: postId, title: topic.title, tag: verdict.tag },
    rejected: rejectedCount,
    evaluated: candidates.length,
  };
}
