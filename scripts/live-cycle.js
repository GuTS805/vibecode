#!/usr/bin/env node
/**
 * Run one real discover -> judge -> write cycle in-process and print every decision.
 *
 *   node scripts/live-cycle.js "Ada" "AI Security"
 *
 * This is the diagnostic the HTTP path cannot give you: it creates a throwaway agent, runs
 * exactly the cycle the scheduler runs, and then prints the published posts *and* the
 * rejection reasons together. Use it when the feed is empty and you need to see whether the
 * cause is discovery, the judge, or the writer.
 */
import 'dotenv/config';
import { resolvePersona, personaSystemPrompt } from '../src/persona.js';
import { createAgent, getPosts, getRejections } from '../src/db.js';
import { runCycle } from '../src/pipeline.js';

const name = process.argv[2] || 'Ada';
const domain = process.argv[3] || 'AI Security';

const resolved = resolvePersona({ name, domain });
const agent = createAgent({
  name: resolved.name,
  domain: resolved.domain,
  personaPrompt: personaSystemPrompt(resolved),
  persona: resolved,
  autonomyHours: 48,
});

console.log(`\n=== ${resolved.name} (${resolved.domain}) agent=${agent.id} ===\n`);

const result = await runCycle(agent.id, { trigger: 'manual' });

console.log('\n--- RESULT ---');
console.log(
  JSON.stringify(
    { published: result.published, rejected: result.rejected, evaluated: result.evaluated, reason: result.reason },
    null,
    2
  )
);

for (const p of getPosts(agent.id)) {
  console.log('\n=============== PUBLISHED ===============');
  console.log('TITLE   :', p.title);
  console.log('TAG     :', p.tag, '| FORMAT:', p.format);
  console.log('TAKEAWAY:', p.takeaway);
  console.log('IMAGE   :', p.imageUrl ? `${p.imageUrl.slice(0, 110)}…` : 'none');
  console.log('TEXT    :', p.text);
}

for (const r of getRejections(agent.id).slice(0, 8)) {
  console.log(`\n[REJECTED ${r.score ?? '?'}] ${String(r.topic).slice(0, 70)}\n    ${r.reason}`);
}

process.exit(0);
