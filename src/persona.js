import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The persona registry is data, not code, so the voice can be reviewed and edited
 * without touching the pipeline. Every prompt in src/pipeline.js and src/discovery.js
 * is built from one of these objects — that shared origin is what keeps discovery,
 * judging, and writing sounding like the same person.
 */
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, 'persona.json'), 'utf8'));

const fill = (value, name, domain) => {
  if (typeof value === 'string') return value.replaceAll('{{name}}', name).replaceAll('{{domain}}', domain);
  if (Array.isArray(value)) return value.map((v) => fill(v, name, domain));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, name, domain)]));
  }
  return value;
};

/**
 * Resolve `{ name, domain }` from POST /api/agent/init into a full persona config.
 *
 * Three steps, most specific first:
 *
 *  1. A name in the registry wins outright — {"name":"Ada"} yields the authored Ada
 *     persona, beat and opinions included.
 *  2. Otherwise a matching domain yields that persona's beat and voice under the caller's
 *     chosen name, so {"name":"Bob","domain":"History"} gets a real historian's config
 *     rather than the generic template. This is what makes the roster reachable without
 *     having to know the authored names.
 *  3. Otherwise the fallback template is filled in, so an arbitrary persona still arrives
 *     with a complete, structurally identical config rather than a half-empty one.
 */
export function resolvePersona({ name, domain }) {
  const nameNeedle = String(name).trim().toLowerCase();
  const domainNeedle = String(domain).trim().toLowerCase();

  const byName = REGISTRY.personas.find(
    (p) => p.matches?.includes(nameNeedle) || p.name.toLowerCase() === nameNeedle
  );
  if (byName) {
    // The caller's domain is recorded, but the beat stays the authored one.
    return { ...byName, name: byName.name, domain: domain || byName.domain, source: 'registry' };
  }

  const byDomain = REGISTRY.personas.find(
    (p) =>
      p.domainMatches?.includes(domainNeedle) ||
      p.domain.toLowerCase() === domainNeedle ||
      // Tolerate "History and Archaeology" or "European history" style inputs.
      p.domainMatches?.some((d) => d.length > 4 && domainNeedle.includes(d))
  );
  if (byDomain) {
    return { ...byDomain, name, domain: domain || byDomain.domain, source: 'registry-by-domain' };
  }

  return {
    ...fill(REGISTRY.fallbackTemplate, name, domain),
    name,
    domain,
    source: 'fallback-template',
  };
}

/**
 * The persona block prepended to every LLM call as the system prompt. Identical text
 * for discovery, judging, and writing — one source of voice for the whole pipeline.
 */
export function personaSystemPrompt(p) {
  const list = (items) => items.map((s) => `- ${s}`).join('\n');

  return `You are ${p.name}, a ${p.role}. Your beat is "${p.domain}".

BIO
${p.bio}

VOICE
- Sentence length: ${p.voice.sentenceLength}
- Formality: ${p.voice.formality}
- Jargon: ${p.voice.jargon}
- Humor: ${p.voice.humor}
- Hedging: ${p.voice.hedging}
- Structure: ${p.voice.structure}

YOU COVER
${list(p.covers)}

YOU DELIBERATELY DO NOT COVER
${list(p.avoids)}

POSITIONS YOU RETURN TO
${p.recurringOpinions.map((o, i) => `${i + 1}. ${o}`).join('\n')}
These are your standing views. Draw on them when a story genuinely bears on one; do not
recite them when it does not, and do not repeat the same one in consecutive posts.

PHRASES YOU NEVER WRITE
${p.bannedPhrases.join(' / ')}
These are the tics of generic AI writing. Your credibility depends on not sounding like that.`;
}

/** Deterministic voice lint. Cheap, runs on every generated post before it is stored. */
export function lintVoice(text, persona) {
  const problems = [];
  const lower = text.toLowerCase();

  for (const phrase of persona.bannedPhrases) {
    if (lower.includes(phrase.toLowerCase())) problems.push(`uses banned phrase "${phrase}"`);
  }
  if (/#\w/.test(text)) problems.push('contains a hashtag');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) problems.push('contains an emoji');
  if (/^\s*[-*•]\s/m.test(text)) problems.push('contains a bullet list');
  if (/^#{1,6}\s/m.test(text)) problems.push('contains a markdown heading');

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const { minWords, maxWords } = persona.post;
  if (words < minWords) problems.push(`too short (${words} words, minimum ${minWords})`);
  if (words > maxWords) problems.push(`too long (${words} words, maximum ${maxWords})`);

  return { ok: problems.length === 0, problems, words };
}

/** First sentence of the bio — enough to tell two personas apart in a picker. */
const tagline = (bio) => {
  const first = String(bio).split(/(?<=\.)\s/)[0];
  return first.length > 180 ? `${first.slice(0, 177)}…` : first;
};

/**
 * The roster, shaped for the persona picker in the UI and for anyone asking what names
 * `/init` recognises. Includes enough of each config — beat, tagline, what it covers and
 * refuses to cover — to choose between them without reading persona.json.
 */
export const listRegistryPersonas = () =>
  REGISTRY.personas.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    domain: p.domain,
    tagline: tagline(p.bio),
    covers: p.covers,
    avoids: p.avoids,
    postLength: `${p.post.minWords}-${p.post.maxWords} words`,
  }));
