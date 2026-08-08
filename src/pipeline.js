import { discoverTopics } from './discovery.js';
import { complete, completeJSON, withRetry } from './llm.js';
import { generateImage } from './pollinations.js';
import { personaSystemPrompt, lintVoice } from './persona.js';
import { getMemory, insertPost, insertRejection, getAgent, loadPersona } from './db.js';

/** At most this many posts per cycle, so a rich news day does not arrive as a burst. */
const MAX_POSTS_PER_CYCLE = Number(process.env.MAX_POSTS_PER_CYCLE || 2);

/** A candidate must clear this to be publishable on its own merits. */
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || 58);

/** No single standard may fall below this, whatever the overall score says. */
const STANDARD_FLOOR = Number(process.env.STANDARD_FLOOR || 30);

/**
 * The floor for the rescue path below. A cycle that judged real candidates and approved
 * none publishes its best one anyway, provided that one is on-beat and not actively bad.
 */
const RESCUE_SCORE = Number(process.env.RESCUE_SCORE || 42);

/**
 * Set ALLOW_EMPTY_CYCLE=true to restore the original strict behaviour, where a cycle in
 * which nothing clears the threshold publishes nothing at all.
 *
 * The default is false because the strict reading produced permanent shutouts rather than
 * occasional quiet cycles: the standards are absolute, so a beat whose feed simply has no
 * five-alarm story today fails all of them every cycle, forever, and the feed stays empty
 * while the logs report a healthy run. Publishing the best available candidate — clearly
 * scored, and only when it is genuinely on-beat — is the difference between an editor
 * having a slow news day and an editor who never files.
 */
const ALLOW_EMPTY_CYCLE = process.env.ALLOW_EMPTY_CYCLE === 'true';

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

You are running a live feed and your readers expect it to be worth checking. Your job is to
find the story worth writing about, not to prove how selective you are. Reject what is
genuinely off your beat, stale, or empty — and publish what is merely ordinary but real. A
solid, on-beat, current story with something concrete in it is publishable even when it is
not the biggest story of the year. Most stories are not.

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

EDITORIAL STANDARDS — score each 0-100. Use the full range: 50 is an ordinary, publishable
story, not a failing grade. Reserve scores under 40 for candidates with a real defect you
can name.

1. BEAT FIT — Does this sit inside the topics you cover? It does not have to be a perfect
   match for your narrowest specialism; adjacent stories you have a genuine angle on
   count. Only score this under 40 if it lands in your do-not-cover list or you would have
   nothing of your own to say about it.

2. SUBSTANCE — Is there something concrete here: a disclosure, a result, a shipped
   artifact, an incident, a policy change with operational consequences, a decision with
   real effects? Pure opinion churn, listicles, and "X is coming" speculation score low.
   An ordinary but real development scores around 55-65 — that is a pass, not a failure.

3. NOVELTY vs YOUR OWN ARCHIVE — Compare against the published posts above. Score low only
   if this repeats a story you already covered or adds nothing to it. A story that is
   simply new to your feed scores well here; it does not have to be new to the world.

4. SOURCE CREDIBILITY — Is the source checkable? A vendor advisory, paper, or disclosure
   writeup outranks a secondary report, which outranks an aggregator — but a named,
   reputable outlet reporting a story is credible enough to write about. Weigh the source
   check above: only a genuinely unverifiable URL is a serious credibility problem.

5. TIMELINESS — Is there a reason to write this now rather than last month? Recent and
   consequential beats recent and trivial. An older item needs real significance to pass.

DECISION RULE
Publish if the overall score is at least ${SCORE_THRESHOLD} and no standard is below ${STANDARD_FLOOR}.
When several candidates in a batch are merely decent, that is still a publishable batch —
the writer's angle is what makes an ordinary story worth reading, and that is their job,
not yours. Reject when the story is off your beat, already covered by you, or hollow.

Return ONLY JSON in exactly this shape:
{
  "scores": { "beatFit": <int>, "substance": <int>, "novelty": <int>, "credibility": <int>, "timeliness": <int> },
  "overall": <int, your holistic score — not necessarily the mean>,
  "decision": "publish" | "reject",
  "reason": "<ONE specific sentence. If rejecting, name the standard it failed and why, referring to this story's specifics — never a generic sentence that could apply to any candidate.>",
  "rationale": "<2-4 sentences: why this topic earns a post, why it matters right now, and what it adds beyond what you have already published. Fill this in even when you are rejecting — write the best case that could be made for the story — because the strongest candidate of a weak batch may still be run.>",
  "tag": "<1-2 word category, e.g. 'Prompt Injection', 'Supply Chain', 'Disclosure', 'Policy'>",
  "angle": "<one sentence: the specific claim a post should lead with. Fill this in even when rejecting, for the same reason.>"
}`;
}

const STANDARDS = ['beatFit', 'substance', 'novelty', 'credibility', 'timeliness'];

/**
 * Put the judge's scores on the 0-100 scale the thresholds assume.
 *
 * The prompt asks for 0-100, and Gemini obliges. Groq's models frequently answer on a 0-10
 * scale instead — a verdict of `overall: 8` meaning "excellent" would be read as 8/100 and
 * rejected, silently turning every cycle into a shutout that looks like strict editing.
 * Detected by shape rather than by provider: if every score present is <= 10 and at least
 * one is non-zero, the whole set is an order of magnitude out and gets scaled.
 */
export function normalizeScores(data) {
  const scores = { ...(data?.scores || {}) };
  const rawOverall = Number.isFinite(data?.overall) ? data.overall : 0;

  const subs = STANDARDS.map((k) => Number(scores[k])).filter(Number.isFinite);
  const onTenScale = (values) => values.length > 0 && values.some((v) => v > 0) && values.every((v) => v <= 10);

  // The two are judged separately rather than as one set, because they drift apart: a model
  // that scores the five standards out of 100 and then answers `overall: 8` meaning
  // "excellent" is common, and treating the set as a whole leaves that 8 unscaled. It then
  // fails the threshold with every standard in the 80s — a shutout that looks exactly like
  // strict editing and is impossible to tell apart from one in the logs.
  const subsAreTenScale = onTenScale(subs);
  if (subsAreTenScale) {
    for (const k of STANDARDS) {
      if (Number.isFinite(Number(scores[k]))) scores[k] = Number(scores[k]) * 10;
    }
  }

  // After any rescaling above, the standards are the reference: an overall of 8 sitting
  // beneath standards averaging 78 is a scale mismatch, not a damning verdict.
  const normalizedSubs = STANDARDS.map((k) => Number(scores[k])).filter(Number.isFinite);
  const subMean = normalizedSubs.length
    ? normalizedSubs.reduce((a, b) => a + b, 0) / normalizedSubs.length
    : null;

  const overallIsTenScale =
    rawOverall > 0 && rawOverall <= 10 && (subMean === null ? subsAreTenScale : subMean > 20);

  const overall = overallIsTenScale ? rawOverall * 10 : rawOverall;

  if (subsAreTenScale || overallIsTenScale) {
    console.warn(
      `[judge] rescaled 0-10 answer to 0-100 (standards: ${subsAreTenScale ? 'yes' : 'no'}, ` +
        `overall: ${overallIsTenScale ? 'yes' : 'no'})`
    );
  }

  return { scores, overall };
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
        // Judging deliberately starts one model down the chain, so the six judging calls in
        // a cycle cannot spend the token budget the single write call needs.
        role: 'judge',
      }),
    { attempts: 2, label: `judge ${candidate.key}` }
  );

  const { scores, overall } = normalizeScores(data);
  const modelSaysPublish = String(data?.decision).toLowerCase() === 'publish';

  // The thresholds are enforced here rather than trusted from the model, so a verdict
  // of "publish" attached to a failing score cannot slip through.
  const values = STANDARDS.map((k) => Number(scores[k]) || 0);
  const meetsBar = overall >= SCORE_THRESHOLD && values.every((v) => v >= STANDARD_FLOOR);

  return {
    decision: modelSaysPublish && meetsBar ? 'publish' : 'reject',
    overriddenByThreshold: modelSaysPublish && !meetsBar,
    scores,
    overall,
    beatFit: Number(scores.beatFit) || 0,
    reason: String(data?.reason || 'No reason returned by the judge.').trim(),
    rationale: String(data?.rationale || '').trim(),
    tag: String(data?.tag || '').trim() || null,
    angle: String(data?.angle || '').trim(),
  };
}

/**
 * The best candidate worth running when nothing cleared the publish threshold.
 *
 * The two gates are what keep this from becoming "publish anything". Beat fit must be
 * genuinely there, because a post outside the persona's beat is worse than no post — it
 * breaks the one promise the feed makes. And the overall score must clear RESCUE_SCORE, so
 * a batch that is uniformly worthless still produces an empty cycle, which is the correct
 * outcome for that batch. Returns undefined when nothing qualifies.
 */
export function pickRescue(declined) {
  return [...declined]
    .filter(({ verdict }) => verdict.beatFit >= 40 && verdict.overall >= RESCUE_SCORE)
    .sort((a, b) => b.verdict.overall - a.verdict.overall)[0];
}

/**
 * Fill in the reasoning a rescued candidate needs before it can be written.
 *
 * The judge is asked to supply a rationale and an angle even when it rejects, precisely so
 * this path has something to work with — but instruction-following is not guaranteed, and
 * the writer cannot produce a post from an empty angle. These fallbacks are built from the
 * story itself so the writer still gets a specific instruction rather than a blank field.
 */
function rescueNarrative({ candidate, verdict }) {
  const rationale =
    verdict.rationale ||
    `${candidate.publisher} reports this and it sits on the beat, so it is worth a short read ` +
      `even though it is not the strongest story of the day. The value here is the interpretation, ` +
      `not the news itself.`;

  const angle =
    verdict.angle ||
    `What ${candidate.title} actually means for someone working on this, stripped of the framing it arrived in.`;

  return { rationale, angle };
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
  "imagePrompt": "<A visual description for the illustration above this post. It must DEPICT THE SUBJECT OF THIS SPECIFIC STORY — name the concrete objects and systems actually involved (an inbox, a server rack, a padlock, a browser window, a chip, a pipeline, a document leaving a building) and show what is happening to them. A reader who saw only the picture should be able to guess the topic. Do NOT return generic abstract art: no unexplained floating shapes, no vague 'digital background', no glowing orbs — those illustrate nothing. Describe the scene, its lighting, and a colour palette suited to the mood. Name ONE to THREE concrete objects that embody this story and show what is happening between them, framed as a tight close-up where those objects fill the frame. Do not describe a room or a wide environment — a wide shot renders as an empty room and illustrates nothing. Write PURELY POSITIVE description: the generator has no negative-prompt support, so 'no text' or 'without people' makes it render text and people. State only what IS there, never what is absent, and give objects blank unmarked surfaces rather than saying they are unlabelled. CHOOSE OBJECTS THAT DO NOT CARRY WRITING IN REAL LIFE. Cables, locks and latches, chains, circuit boards, silicon wafers, pipes and valves, gears and mechanisms, keys, glass panels, liquid, smoke, light beams, folded metal — these render cleanly. Anything that carries writing in reality will be rendered covered in garbled fake lettering: documents, paper, files, cards, labels, signs, doors, screens, monitors, packaging, boxes, books, dials, keyboards. Build the picture only from the first group — if the story is about a document leaking, draw the cables and the broken lock, not the document. Good: 'a bundle of cables tearing free of a sealed metal housing, one strand glowing hot'. Bad: 'a document slipping out of a server' or 'an office with no people'. 20-35 words.>"
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
      // The one call whose output a reader actually sees; it gets the best model available.
      role: 'write',
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

/**
 * Style contract applied to every image, so a feed of posts looks like one publication.
 *
 * Two hard-won constraints are encoded here.
 *
 * First, it is deliberately not "abstract". Asking for abstraction produced glowing orbs and
 * floating polygons that illustrated nothing; this asks for a depicted scene instead.
 *
 * Second — and this is the non-obvious one — it contains no negations. Pollinations' URL API
 * has no separate negative-prompt field, so "no faces, no people" lands in the *positive*
 * prompt and summons exactly what it was meant to exclude. Verified: a brief ending in
 * "no faces, no people" returned a portrait of a person staring into the camera. Absence is
 * therefore expressed positively — "deserted", "objects only", "still life" — which the
 * generator can actually act on.
 */
const IMAGE_STYLE =
  'editorial illustration, tight close-up still life, the objects fill the frame and are the ' +
  'entire subject, centred symmetrical composition, dramatic studio side lighting, dark moody ' +
  'background, high contrast, subtle film grain, smooth featureless unmarked surfaces';

/**
 * Strip negations from a brief before it reaches the generator.
 *
 * The writing model is told not to use them, but instruction-following here is unreliable
 * and the cost of one leaking through is an image containing the very thing it forbade. This
 * is the deterministic backstop.
 */
export function stripNegations(brief) {
  return String(brief)
    // "no text", "no brand logos", "without any labels", "avoid faces"
    .replace(/\b(?:with)?\s*no\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}\b/gi, ' ')
    .replace(/\bwithout\s+(?:any\s+)?[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}\b/gi, ' ')
    .replace(/\bavoid(?:ing)?\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}\b/gi, ' ')
    // "not a diagram", "never showing text"
    .replace(/\b(?:not|never)\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}\b/gi, ' ')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;]+|[\s,.;]+$/g, '')
    .trim();
}

/**
 * Concrete visual scenes, matched against what the story is actually about.
 *
 * The previous anchor took the headline's significant words and pasted them into the image
 * prompt — "openai gpt-5 disclosure patch". That does not work, for two compounding reasons.
 * A diffusion model has no idea what a "disclosure" looks like, so those tokens contribute
 * nothing but noise; and proper nouns and abstract nouns in a prompt are precisely what
 * `sana` renders as garbled pseudo-lettering across the image. The result was artwork that
 * was both generic and covered in fake text.
 *
 * Each entry maps a subject to physical objects that can actually be drawn, chosen from the
 * classes that render cleanly — metal, cable, glass, light, liquid, mechanism — and never
 * from the classes that carry writing in real life. The matching is deliberately ordered:
 * the more specific patterns sit first, so "model weights leaked" resolves to the weights
 * scene rather than the generic breach scene.
 */
const VISUAL_CONCEPTS = [
  // Tier 1 — terms that mean one thing only, whatever beat the story came from.
  [/prompt inject|jailbreak|indirect inject/, 'a hairline crack splitting a thick pane of armoured glass, a thin bright filament threading through the crack from the far side'],
  [/supply chain|dependency confusion|package registry|\bnpm\b|\bpypi\b/, 'a chain of machined steel links running into darkness, one link in the centre visibly counterfeit and softening open'],
  [/model weight|checkpoint|deserializ|safetensors/, 'stacked slabs of dark translucent glass glowing faintly from within, one slab slid out of alignment'],
  [/ransomware|malware|trojan|backdoor|botnet|phishing/, 'a heavy brass lock cut clean through, the shackle lying open on brushed steel, fine metal dust around the cut'],
  [/\bcve\b|zero-day|vulnerab|exploit(ed|ation)?\b|security advisory|patch(ed|es)?\b/, 'a precision-machined metal panel with one bolt sheared off, the hole beneath it dark and open'],
  [/breach|exfiltrat|data leak|leaked data|stolen (data|records)|exposed (data|records)/, 'a bundle of fibre-optic cables torn free of a sealed metal housing, light bleeding from the severed ends'],
  [/sandbox|credential|api key|access token|privilege escalation/, 'a bank of heavy latches on a steel bulkhead, most sealed shut, one swung fully open'],
  [/\bchip\b|\bgpu\b|silicon|semiconductor|nvidia|wafer|fabricat/, 'a silicon wafer under raking light, its concentric circuitry catching the beam, held in a steel vacuum arm'],
  [/data ?cent(re|er)|server (rack|farm)|cloud (outage|region)|infrastructure outage/, 'a dense wall of cabling and cooling pipes in a machine hall, condensation beading on the metal'],
  [/quantum|cryptograph|encryption|key exchange/, 'a lattice of thin brass rods suspended in cold blue light, frost forming along the lower rods'],

  // Tier 2 — subject domains. These sit above the general technology vocabulary below,
  // because that vocabulary is full of words that mean something else entirely outside
  // tech: a WWII story about a tunnel network is not about fibre optics, and a football
  // story about a training camp is not about model training.
  [/music|album|\bsong\b|\bband\b|concert|recording artist|\bgig\b/, 'a close-up of a vibrating steel string over a lacquered wooden body, dust lifting off it'],
  [/sport|football|soccer|basketball|cricket|tennis|athlet|league|tournament|olympic/, 'a worn leather grip and polished steel under floodlight, scuffed from use'],
  [/histor|archaeolog|ancient|medieval|excavat|artefact|artifact|ruins|antiquit/, 'a fragment of weathered carved stone half-lifted from packed earth, a soft brush resting against it'],
  [/geograph|\bmap\b|border|territory|glacier|\briver\b|coastline|terrain/, 'contoured layers of cut slate stacked into a relief, a thin channel of water running through the lowest layer'],
  [/election|\bvote|ballot|campaign trail|parliament|senate|congress/, 'a sealed steel ballot drum on a plain table, the slot cut into its top catching hard light'],
  [/regulat|legislat|\blaw\b|court|ruling|lawsuit|compliance|antitrust|sanction/, 'a pair of heavy brass scale pans on a marble surface, one pan weighed down by a solid steel block'],
  [/protein|genome|biotech|medical|clinical|\bdrug\b|vaccine/, 'a rack of sealed glass vials in a steel cradle, one lit from below through pale liquid'],
  [/satellite|spacecraft|\borbit|telescope|\bnasa\b|\blunar\b|\bmars\b/, 'a gold-foiled instrument panel angled against deep black, a lens element catching a hard rim of light'],
  [/climate|emission|wildfire|drought|flood|ecosystem|biodiversity|coral|glacier/, 'a cracked bed of dried mud under hard low light, a shallow film of water pooling in the deepest fissure'],
  [/robot|drone|autonomous vehicle|self-driving/, 'a precision articulated joint of steel and cable mid-motion, the hydraulic line taut'],
  [/funding round|acquisition|valuation|\bipo\b|revenue|market share/, 'interlocking brass gears of very different sizes meshed on a dark workbench, one turning against the others'],

  // Tier 3 — general technology vocabulary. Last, because these words are the ones most
  // likely to appear incidentally in a story that is really about something else.
  [/training (data|run|set)|dataset|corpus|benchmark|\beval\b/, 'clear liquid pouring between two glass vessels through a fine steel mesh, sediment collecting in the mesh'],
  [/\bdns\b|routing|bandwidth|network traffic|packet/, 'a junction of hundreds of coloured fibre strands fanning out of a single steel collar'],
  [/\bai\b|\bllm\b|model|algorithm|software|browser|platform/, 'nested panes of clear glass at slight angles, light refracting through the stack onto a dark surface'],
  [/energy|power grid|electricity|reactor/, 'thick copper busbars rising out of a cooling bath, steam curling off the surface'],
];

/** Last resort when nothing matched — still concrete, still cleanly renderable. */
const DEFAULT_CONCEPT =
  'a precision steel mechanism partly disassembled on a dark surface, one component lifted clear and catching the light';

/**
 * The visual subject for this post, derived from what the story is about.
 *
 * The writer's own brief is still the main driver — it knows the specifics. This runs
 * alongside it as the anchor, because briefs drift abstract under pressure and an abstract
 * brief produces artwork that could sit above any post, which is worse than no artwork.
 */
function subjectAnchor(candidate, verdict) {
  const haystack = `${verdict.tag || ''} ${candidate.title} ${candidate.summary}`.toLowerCase();
  const hit = VISUAL_CONCEPTS.find(([pattern]) => pattern.test(haystack));
  return hit ? hit[1] : DEFAULT_CONCEPT;
}

/**
 * Attach artwork to a post. Never throws: a post without an image is still a good post,
 * and artwork must not be able to fail a cycle that already did the expensive work.
 */
/**
 * The full prompt sent to the generator.
 *
 * Anchor first: the generator weights the opening of a prompt most heavily, and the anchor
 * is the part guaranteed to be both on-subject and free of the nouns that render as fake
 * lettering. The writer's brief follows as the story-specific detail — when it is present
 * and concrete it sharpens the scene, and when it has drifted abstract the anchor has
 * already established what is being depicted.
 *
 * Exported so the concept matching can be tested without generating an image.
 */
export function buildImageBrief(candidate, verdict, draft = {}) {
  const anchor = subjectAnchor(candidate, verdict);
  const brief = stripNegations(draft.imagePrompt || '');
  return [anchor, brief, IMAGE_STYLE].filter(Boolean).join('. ');
}

export async function attachImage(candidate, verdict, persona, draft) {
  if (!IMAGES_ENABLED) return { imageUrl: null, imagePrompt: null };

  const full = buildImageBrief(candidate, verdict, draft);

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

  // Partition first and write the rejections afterwards, so the rescue path below can
  // still promote a candidate that would otherwise have been filed as rejected.
  const approved = [];
  const declined = [];

  for (const { candidate, verdict } of verdicts) {
    if (!verdict) continue; // judging errored; leave it unseen so it can resurface
    (verdict.decision === 'publish' ? approved : declined).push({ candidate, verdict });
  }

  // Nothing cleared the bar. Rather than filing another empty cycle, run the best
  // candidate that is at least on-beat and not hollow. It is marked as a rescue in the
  // log and its real score is stored, so a thin post is never presented as a strong one.
  if (!approved.length && !ALLOW_EMPTY_CYCLE && declined.length) {
    const best = pickRescue(declined);

    if (best) {
      const i = declined.indexOf(best);
      declined.splice(i, 1);
      best.verdict = { ...best.verdict, rescued: true, ...rescueNarrative(best) };
      approved.push(best);
      console.log(
        `[cycle:${trigger}] nothing cleared ${SCORE_THRESHOLD}; running best available ` +
          `"${best.candidate.title.slice(0, 50)}" (score ${best.verdict.overall})`
      );
    } else {
      console.log(`[cycle:${trigger}] no candidate was on-beat enough to rescue`);
    }
  }

  for (const { candidate, verdict } of declined) {
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
  }
  const rejectedCount = declined.length;

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
