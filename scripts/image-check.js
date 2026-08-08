/**
 * Diagnostic for the write-and-illustrate path.
 *
 * The judge rejects most real candidates by design, so a live cycle is an unreliable way to
 * exercise writing and artwork — a run that publishes nothing is a working run, and proves
 * nothing about this code. This drives the same functions the pipeline uses against a fixed
 * synthetic candidate, so the output is about the code rather than about today's news.
 *
 *   npm run image-check
 */
import 'dotenv/config';
import { writePost, attachImage, chooseFormat, FORMATS } from '../src/pipeline.js';
import { resolvePersona } from '../src/persona.js';

const candidate = {
  key: 'agent-browser-cloudflare-sandbox-launch',
  title: 'Cloudflare launches Kitesurf, a browser built for AI agents',
  summary:
    'Cloudflare announced a browser designed for autonomous AI agents to interact with the web, ' +
    'aimed at sandboxing agent execution, managing bot traffic, and asserting agent identity.',
  url: 'https://techcrunch.com/2026/08/07/cloudflare-launches-kitesurf/',
  extraUrls: [],
  publisher: 'TechCrunch',
  publishedAt: '2026-08-07',
  ageHours: 6,
  claimStatus: 'reported',
  whyOnBeat: 'Agent sandboxing and execution boundaries.',
  urlVerified: true,
  hostVerified: true,
  resolvedFromGrounding: false,
};

const verdict = {
  decision: 'publish',
  overall: 82,
  tag: 'Agent Security',
  rationale:
    'This shifts the security boundary from model guardrails to runtime execution environments, ' +
    'which matters immediately for anyone deploying agents against untrusted web content.',
  angle: 'The security boundary for agents is moving into the browser layer.',
};

const persona = resolvePersona({ name: 'Ada', domain: 'AI Security' });
const memory = { publishedSummaries: [], publishedTopics: [], seenKeys: new Set(), recentFormats: [] };

console.log(`persona: ${persona.name} — ${persona.domain} (${persona.source})`);
console.log(`formats available: ${FORMATS.map((f) => f.id).join(', ')}\n`);

const format = chooseFormat(candidate, memory);
console.log(`chosen format: ${format.id}\n`);

const draft = await writePost(persona, candidate, verdict, memory, format);

console.log('─'.repeat(70));
console.log('TAKEAWAY:', draft.takeaway || '(none)');
console.log('─'.repeat(70));
console.log(draft.text);
console.log('─'.repeat(70));
console.log(`words: ${draft.lint.words} | voice lint: ${draft.lint.ok ? 'pass' : draft.lint.problems.join('; ')}`);
console.log('\nIMAGE PROMPT:', draft.imagePrompt || '(none — will use fallback)');

const { imageUrl } = await attachImage(candidate, verdict, persona, draft);
console.log('IMAGE URL:', imageUrl ? `${imageUrl.slice(0, 110)}…` : 'null (post publishes text-only)');

const problems = [];
if (!draft.text) problems.push('no post text');
if (!draft.takeaway) problems.push('no takeaway');
if (draft.takeaway && draft.takeaway.length > 130) problems.push(`takeaway too long (${draft.takeaway.length})`);
if (!imageUrl) problems.push('no image');
if (/\b(no text|no logos|abstract editorial)\b/i.test(draft.text)) problems.push('style directives leaked into post text');

console.log(problems.length ? `\nPROBLEMS: ${problems.join(', ')}` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
