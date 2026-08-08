import { discoverTopics } from './discovery.js';
import { complete, completeJSON, withRetry } from './llm.js';
import { generateImage } from './pollinations.js';
import { personaSystemPrompt, lintVoice } from './persona.js';
import { getMemory, insertPost, insertRejection, getAgent, loadPersona } from './db.js';

/** At most this many posts per cycle, so a rich news day does not arrive as a burst. */
const MAX_POSTS_PER_CYCLE = Number(process.env.MAX_POSTS_PER_CYCLE || 2);

/** A candidate must clear this to be publishable at all. */
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || 70);

/** Set POST_IMAGES=false to publish text-only and skip image generation entirely. */
const IMAGES_ENABLED = process.env.POST_IMAGES !== 'false';

/**
 * Structural formats, rotated across posts.
 *
 * A persona with one strong voice still produces a monotonous feed if every post is built
 * the same way — same opening move, same three beats, same close. The voice is what should
 * stay constant; the structure is what should vary. Each format changes what the post is
 * *doing*, not how it sounds, so posts stay recognisably the same author.
 */
export const FORMATS = [
  {
    id: 'analysis',
    instruction:
      'Lead with the substantive claim, then explain the mechanism behind it, then say what it changes for practitioners.',
  },
  {
    id: 'contrarian',
    instruction:
      'Identify the consensus reading of this story and push against it. Be specific about what the consensus gets wrong and why. Do not be contrarian for its own sake — if the consensus is right, say that instead and explain what people are still missing.',
  },
  {
    id: 'field-note',
    instruction:
      'Write this as a practitioner note: what someone doing this work should actually do differently, concretely, starting now. Prioritise the operational over the theoretical.',
  },
  {
    id: 'threat-model',
    instruction:
      'Work through what this enables or breaks. Who gains a capability, who carries new risk, and what the realistic failure mode looks like. Stay concrete about the chain of events.',
  },
  {
    id: 'context',
    instruction:
      'Place this in the arc it belongs to. What came before that makes this the predictable next step, and what it implies about where the next move lands. Avoid a history lecture — the past is only there to sharpen the present claim.',
  },
  {
    id: 'skeptic',
    instruction:
      'Interrogate the claim itself. What is actually demonstrated versus asserted, what evidence would settle it, and how much weight the claim can currently bear. If the story is thin, say so plainly and explain what is missing.',
  },
];

/**
 * Pick a format that has not been used recently, so the feed does not fall into a pattern.
 * The story's own character gets first say — an unverifiable vendor claim should be read
 * skeptically regardless of what the rotation would otherwise have chosen.
 */
export function chooseFormat(candidate, memory) {
  const recent = (memory.recentFormats || []).slice(0, 3);
  const available = FORMATS.filter((f) => !recent.includes(f.id));
  const pool = available.length ? available : FORMATS;

  if (candidate.claimStatus === 'asserted') {
    const skeptic = pool.find((f) => f.id === 'skeptic');
    if (skeptic) return skeptic;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ------------------------------ editorial judgment ----------------------------- */

/**
 * The editorial standards, written out once and applied per candidate. They live in the
 * prompt rather than in code because the judgement they encode is qualitative — but the
 * scores and the decision come back structured, so the outcome is auditable.
 */
function judgePrompt(persona, candidate, memory) {
  const published = memory.publishedSummaries.length
    ? memory.publishedSummaries.map((p, i) => `${i + 1}. [${p.createdAt}] ${p.title}\n   ${p.excerpt}`).join('\n')
    : '(nothing published yet — this is the first cycle)';

  const sourceNote = candidate.resolvedFromGrounding
    ? 'CONFIRMED. This link came from the search results and was followed to its destination, so the page provably exists and is provably what the search returned. Do not doubt this URL — judge the publisher on its merits instead.'
    : candidate.urlVerified
      ? 'CONFIRMED. This URL appeared verbatim among the search sources.'
      : candidate.hostVerified
        ? 'PARTLY CONFIRMED. This publisher appeared among the search sources, though this exact link was not resolved. The story is corroborated; treat the specific link as probable rather than certain. This alone is not grounds for rejection.'
        : 'UNCONFIRMED. Neither this URL nor its publisher appeared among the search sources, which suggests the model composed it rather than reading it. Weigh this heavily under SOURCE CREDIBILITY.';

  return `Decide whether to publish a post about this candidate. You are the editor here, not the writer.

CANDIDATE
Title:       ${candidate.title}
Summary:     ${candidate.summary}
Publisher:   ${candidate.publisher}
URL:         ${candidate.url}${candidate.extraUrls.length ? `\nAlso cited:  ${candidate.extraUrls.join(', ')}` : ''}
Published:   ${candidate.publishedAt || 'unknown'}${candidate.ageHours != null ? ` (~${candidate.ageHours}h ago)` : ''}
Claim type:  ${candidate.claimStatus}
Pitched as:  ${candidate.whyOnBeat}
Source check: ${sourceNote}

YOUR LAST ${memory.publishedSummaries.length} PUBLISHED POSTS
${published}

EDITORIAL STANDARDS — score each 0-100 and apply them strictly.
Rejecting is the normal outcome. A cycle that publishes nothing is a working cycle.

1. BEAT FIT — Does this sit inside the topics you cover, specifically? "It is about
   technology" is not fit. If it lands in your do-not-cover list, this score is under 30
   and the decision is reject regardless of everything else.

2. SUBSTANCE — Is there a real development: a disclosure, a result, a shipped artifact,
   an incident, a policy change with operational consequences? Reject announcement-only
   news, opinion churn, listicles, funding noise with no technical detail, and
   "X is coming" speculation. An announcement with nothing anyone can inspect scores low
   here even when the subject matter is squarely on your beat.

3. NOVELTY vs YOUR OWN ARCHIVE — Compare against the published posts above. Reject
   anything that repeats a story you covered, or that is a follow-up adding nothing your
   readers do not already have from you. Being new to the world is not enough; it has to
   be new relative to what you have already said.

4. SOURCE CREDIBILITY — Is the source primary and checkable? A vendor advisory, paper,
   or disclosure writeup outranks a secondary report, which outranks an aggregator. Weigh
   the source check above: an unverifiable URL is a serious credibility problem, because
   you would be citing something you cannot confirm exists.

5. TIMELINESS — Is there a reason to write this now rather than last month? Recent and
   consequential beats recent and trivial. An older item needs real significance to pass.

DECISION RULE
Publish only if it clears every standard and the overall score is at least ${SCORE_THRESHOLD}.
Any single standard scoring under 40 means reject.

Return ONLY JSON in exactly this shape:
{
  "scores": { "beatFit": <int>, "substance": <int>, "novelty": <int>, "credibility": <int>, "timeliness": <int> },
  "overall": <int, your holistic score — not necessarily the mean>,
  "decision": "publish" | "reject",
  "reason": "<ONE specific sentence. If rejecting, name the standard it failed and why, referring to this story's specifics — never a generic sentence that could apply to any candidate.>",
  "rationale": "<2-4 sentences, only if publishing: why this topic earns a post, why it matters right now, and what it adds beyond what you have already published. Empty string if rejecting.>",
  "tag": "<1-2 word category, e.g. 'Prompt Injection', 'Supply Chain', 'Disclosure', 'Policy'>",
  "angle": "<one sentence, only if publishing: the specific claim the post should lead with>"
}`;
}

async function judgeCandidate(persona, candidate, memory) {
  const { data } = await withRetry(
    () =>
      completeJSON({
        system: personaSystemPrompt(persona),
        prompt: judgePrompt(persona, candidate, memory),
        maxTokens: 3000,
        effort: 'medium',
        label: `judge:${candidate.key.slice(0, 24)}`,
      }),
    { attempts: 2, label: `judge ${candidate.key}` }
  );

  const scores = data?.scores || {};
  const overall = Number.isFinite(data?.overall) ? data.overall : 0;
  const modelSaysPublish = String(data?.decision).toLowerCase() === 'publish';

  // The thresholds are enforced here rather than trusted from the model, so a verdict
  // of "publish" attached to a failing score cannot slip through.
  const values = ['beatFit', 'substance', 'novelty', 'credibility', 'timeliness'].map(
    (k) => Number(scores[k]) || 0
  );
  const meetsBar = overall >= SCORE_THRESHOLD && values.every((v) => v >= 40);

  return {
    decision: modelSaysPublish && meetsBar ? 'publish' : 'reject',
    overriddenByThreshold: modelSaysPublish && !meetsBar,
    scores,
    overall,
    reason: String(data?.reason || 'No reason returned by the judge.').trim(),
    rationale: String(data?.rationale || '').trim(),
    tag: String(data?.tag || '').trim() || null,
    angle: String(data?.angle || '').trim(),
  };
}

/* ---------------------------------- writing ----------------------------------- */

function writePrompt(persona, candidate, verdict, memory, format) {
  const recent = memory.publishedSummaries.slice(0, 5);
  const recentBlock = recent.length
    ? recent.map((p, i) => `${i + 1}. ${p.title}\n   "${p.excerpt}"`).join('\n')
    : '(no previous posts)';

  return `Write your next post.

STORY
Title:      ${candidate.title}
Summary:    ${candidate.summary}
Publisher:  ${candidate.publisher}
URL:        ${candidate.url}
Claim type: ${candidate.claimStatus} ${
    candidate.claimStatus === 'asserted'
      ? '— this is a vendor claim with nothing independently inspectable. Say so in the post.'
      : ''
  }

YOUR EDITORIAL REASONING FOR RUNNING IT
${verdict.rationale}

THE ANGLE
${verdict.angle}

YOUR FIVE MOST RECENT POSTS — do not reuse their openings, structure, or closing move:
${recentBlock}

HOW TO BUILD THIS ONE
${format.instruction}
This is about structure, not voice. You still sound exactly like yourself.

REQUIREMENTS
${persona.post.rules.map((r) => `- ${r}`).join('\n')}
- ${persona.post.minWords}-${persona.post.maxWords} words. One self-contained post, plain prose.
- Write in your own voice as described in your persona. This should be unmistakably yours.
- Do not restate the headline and stop. The value is your read on what it means for
  someone working in ${persona.domain}.

Return ONLY JSON in exactly this shape, with no prose before or after:
{
  "text": "<the post itself, plain prose, no title, no sign-off, no surrounding quotes>",
  "takeaway": "<ONE sentence, under 110 characters: the single thing a reader should remember. Not a summary of the post — the point of it. No lead-in like 'The takeaway is'.>",
  "imagePrompt": "<A visual description for an abstract editorial illustration to sit above this post. Describe shapes, composition, lighting, and a colour palette that suits the subject's mood. It must be ABSTRACT and CONCEPTUAL — absolutely no text, letters, numbers, words, logos, brand marks, faces, or recognisable people, because the image generator renders those as garbled artefacts. Think magazine cover art, not a diagram. 20-35 words.>"
}`;
}

const clean = (s) => String(s ?? '').replace(/^["']|["']$/g, '').trim();

/**
 * Write the post, its takeaway, and its artwork brief in a single call.
 *
 * These could be three calls, and three calls would each be simpler. They are one because
 * the write step runs last in the cycle, after discovery and every judging call have
 * already spent quota against a small daily allowance — and because the takeaway and the
 * image brief are both derived from the post, so a model that just wrote it is better
 * placed to produce them than one being told about it second-hand.
 */
export async function writePost(persona, candidate, verdict, memory, format) {
  const ask = async (extraNote = '', label = 'write') => {
    const { data } = await completeJSON({
      system: personaSystemPrompt(persona),
      prompt: writePrompt(persona, candidate, verdict, memory, format) + extraNote,
      maxTokens: 2500,
      effort: 'low',
      label,
    });
    return {
      text: clean(data?.text),
      takeaway: clean(data?.takeaway),
      imagePrompt: clean(data?.imagePrompt),
    };
  };

  let draft = await withRetry(() => ask(), { attempts: 3, label: `write ${candidate.key}` });

  // A response that parsed but carried no post is a failed write, not a publishable one.
  if (!draft.text) {
    const e = new Error('Write call returned no post text.');
    e.code = 'EMPTY_POST';
    e.retryable = true;
    throw e;
  }

  // Deterministic voice gate. One regeneration attempt, naming the exact violations —
  // cheaper and more reliable than hoping the first draft always lands.
  let lint = lintVoice(draft.text, persona);
  if (!lint.ok) {
    console.warn(`[write] voice lint failed: ${lint.problems.join('; ')} — regenerating once`);
    try {
      const retry = await ask(
        `\n\nA previous draft was rejected by the style check for these reasons:\n` +
          `${lint.problems.map((p) => `- ${p}`).join('\n')}\n` +
          `Write a new post that does not have these problems. Do not acknowledge this note.`,
        'write:retry'
      );
      const retryLint = lintVoice(retry.text, persona);
      // Keep the retry only if it is actually an improvement.
      if (retry.text && retryLint.problems.length < lint.problems.length) {
        draft = retry;
        lint = retryLint;
      }
    } catch (err) {
      // The first draft is usable; a failed retry should not lose it.
      console.warn(`[write] regeneration failed, keeping first draft: ${err.message}`);
    }
  }

  return { ...draft, lint };
}

/* ---------------------------------- artwork ----------------------------------- */

/** Style contract applied to every image, so a feed of posts looks like one publication. */
const IMAGE_STYLE =
  'abstract editorial illustration, conceptual, cinematic lighting, dark background, ' +
  'high contrast, minimal composition, subtle grain, no text, no words, no letters, ' +
  'no logos, no watermark, no faces, no people';

/**
 * Fallback brief for when the model returned no usable imagePrompt. Derived from the tag
 * and beat so it still relates to the post rather than being generic filler.
 */
function fallbackImagePrompt(candidate, verdict, persona) {
  const subject = verdict.tag || persona.domain;
  return `abstract representation of ${subject}, interlocking geometric forms, flowing data currents, deep blue and cyan light`;
}

/**
 * Attach artwork to a post. Never throws: a post without an image is still a good post,
 * and artwork must not be able to fail a cycle that already did the expensive work.
 */
export async function attachImage(candidate, verdict, persona, draft) {
  if (!IMAGES_ENABLED) return { imageUrl: null, imagePrompt: null };

  const brief = draft.imagePrompt || fallbackImagePrompt(candidate, verdict, persona);
  const full = `${brief}. ${IMAGE_STYLE}`;

  try {
    // Seed from the story key so the same post always resolves to the same artwork.
    const imageUrl = await generateImage(full, { seed: seedFromKey(candidate.key) });
    return { imageUrl, imagePrompt: imageUrl ? full : null };
  } catch (err) {
    console.warn(`[image] skipped: ${err.message}`);
    return { imageUrl: null, imagePrompt: null };
  }
}

function seedFromKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 1_000_000;
}

/* --------------------------------- the cycle ---------------------------------- */

/**
 * One discover -> judge -> remember -> write -> publish cycle.
 * Identical code path whether fired by node-cron or by POST /api/agent/trigger.
 */
export async function runCycle(agentId, { trigger = 'cron' } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const persona = loadPersona(agent);
  const started = Date.now();
  console.log(`[cycle:${trigger}] ${persona.name} (${agentId}) starting`);

  // Memory check happens before discovery so already-covered topics never reach the
  // search prompt, and before writing so the writer can avoid repeating itself.
  const memory = getMemory(agentId);

  const { candidates: discovered, searchNotes } = await discoverTopics(persona, memory);

  // Deterministic memory filter: a story this agent already published or rejected does
  // not get re-judged, however the search happens to phrase it this time.
  const fresh = discovered.filter((c) => !memory.seenKeys.has(c.key));
  const skipped = discovered.length - fresh.length;
  if (skipped) console.log(`[cycle:${trigger}] ${skipped} candidate(s) filtered by memory`);

  if (!fresh.length) {
    console.log(`[cycle:${trigger}] nothing new discovered (${discovered.length} seen before)`);
    return {
      published: [], rejected: 0, evaluated: 0,
      reason: discovered.length ? 'all-topics-previously-seen' : 'no-candidates-found',
      searchNotes,
    };
  }

  // One judging call per candidate. Separate calls mean each verdict is reasoned about on
  // its own merits instead of being ranked against its neighbours.
  //
  // Sequential, not concurrent: firing these in parallel bursts straight through the free
  // tier's per-minute cap, which then starves the write call at the end of the cycle — the
  // exact failure the first live run hit. Cycles are hours apart, so the added seconds are
  // free, and a rate-limit backoff inside one judgement no longer collides with the others.
  const verdicts = [];
  let firstJudgeError = null;
  for (const candidate of fresh) {
    try {
      verdicts.push({ candidate, verdict: await judgeCandidate(persona, candidate, memory) });
    } catch (err) {
      // A judging failure must not take the cycle down with it.
      console.warn(`[judge] failed for "${candidate.title.slice(0, 50)}": ${err.message}`);
      firstJudgeError = firstJudgeError || err;
      verdicts.push({ candidate, verdict: null });
    }
  }

  // If nothing could be judged at all, the provider is down — not the editor being strict.
  // Reporting "nothing cleared the bar" here would describe an outage as an editorial
  // outcome, so the underlying error is surfaced instead and /trigger maps it to a real
  // status code.
  if (firstJudgeError && verdicts.every((v) => !v.verdict)) {
    console.error(`[cycle:${trigger}] every candidate failed to judge — surfacing provider error`);
    throw firstJudgeError;
  }

  const approved = [];
  let rejectedCount = 0;

  for (const { candidate, verdict } of verdicts) {
    if (!verdict) continue; // judging errored; leave it unseen so it can resurface
    if (verdict.decision === 'publish') {
      approved.push({ candidate, verdict });
      continue;
    }
    insertRejection({
      agentId,
      topic: candidate.title,
      reason: verdict.overriddenByThreshold
        ? `${verdict.reason} (Scored ${verdict.overall}, below the publish threshold of ${SCORE_THRESHOLD}.)`
        : verdict.reason,
      topicKey: candidate.key,
      url: candidate.url,
      score: verdict.overall,
    });
    rejectedCount++;
  }

  // Best-scoring approvals run now; the rest are neither published nor rejected, so they
  // stay eligible and can resurface next cycle rather than being silently discarded.
  approved.sort((a, b) => b.verdict.overall - a.verdict.overall);
  const toPublish = approved.slice(0, MAX_POSTS_PER_CYCLE);
  const deferred = approved.slice(MAX_POSTS_PER_CYCLE);
  if (deferred.length) {
    console.log(`[cycle:${trigger}] ${deferred.length} approved candidate(s) deferred to a later cycle`);
  }

  if (!toPublish.length) {
    console.log(
      `[cycle:${trigger}] nothing cleared the bar (${rejectedCount}/${fresh.length} rejected, ${Date.now() - started}ms)`
    );
    return {
      published: [], rejected: rejectedCount, evaluated: fresh.length,
      reason: 'nothing-cleared-bar', searchNotes,
    };
  }

  const published = [];
  for (const { candidate, verdict } of toPublish) {
    try {
      const format = chooseFormat(candidate, memory);
      const draft = await writePost(persona, candidate, verdict, memory, format);
      const { text, takeaway, lint } = draft;

      // Artwork runs after the post exists and cannot fail it.
      const { imageUrl, imagePrompt } = await attachImage(candidate, verdict, persona, draft);

      const sources = [candidate.url, ...candidate.extraUrls];

      // The rationale is the judge's own reasoning about this specific story, with the
      // sources it rests on appended — selection, timeliness, and provenance in one field.
      const rationale = `${verdict.rationale} Sources: ${sources.join(', ')}`;

      const postId = insertPost({
        agentId,
        title: candidate.title,
        text,
        rationale,
        sources,
        topicKey: candidate.key,
        tag: verdict.tag,
        score: verdict.overall,
        imageUrl,
        imagePrompt,
        takeaway: takeaway || null,
        format: format.id,
      });

      published.push({
        id: postId,
        title: candidate.title,
        tag: verdict.tag,
        score: verdict.overall,
        format: format.id,
        hasImage: Boolean(imageUrl),
      });
      console.log(
        `[cycle:${trigger}] published ${postId} "${candidate.title.slice(0, 50)}" ` +
          `(score ${verdict.overall}, ${format.id}, ${lint.words} words, ` +
          `image ${imageUrl ? 'yes' : 'no'}${lint.ok ? '' : `, lint: ${lint.problems.join('; ')}`})`
      );

      // Keep memory current within the cycle so a second post cannot echo the first, and
      // so the format rotation sees what this cycle has already used.
      memory.publishedSummaries.unshift({
        createdAt: new Date().toISOString().slice(0, 10),
        title: candidate.title,
        excerpt: text.slice(0, 180),
      });
      memory.seenKeys.add(candidate.key);
      memory.recentFormats = [format.id, ...(memory.recentFormats || [])];
    } catch (err) {
      console.error(`[write] failed for "${candidate.title.slice(0, 50)}": ${err.message}`);
    }
  }

  console.log(
    `[cycle:${trigger}] done — ${published.length} published, ${rejectedCount} rejected, ${Date.now() - started}ms`
  );

  return { published, rejected: rejectedCount, evaluated: fresh.length, searchNotes };
}
