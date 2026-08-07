#!/usr/bin/env node
/**
 * Automated persona voice review.
 *
 *   npm run voice-check -- <agentId> [count]
 *
 * Two passes over the agent's most recent posts:
 *
 *   1. A deterministic lint (banned phrases, hashtags, emoji, markdown, word count) —
 *      the same check the writer runs before storing a post, re-applied here so the
 *      report also catches anything published before a persona edit.
 *
 *   2. An LLM review that scores each post against the persona's own style guide and
 *      then judges the set as a whole: does this read as one consistent person, or as
 *      several? Cross-post consistency is the part a per-post lint cannot see.
 *
 * Exits non-zero if any post fails the lint or scores below the pass mark, so this can
 * run in CI as well as by hand.
 */

import 'dotenv/config';
import { db, getAgent, loadPersona } from '../src/db.js';
import { personaSystemPrompt, lintVoice } from '../src/persona.js';
import { completeJSON } from '../src/gemini.js';

const PASS_MARK = 70;

const [agentIdArg, countArg] = process.argv.slice(2);
const COUNT = Math.max(2, Math.min(10, Number(countArg) || 4));

function resolveAgent() {
  if (agentIdArg) {
    const agent = getAgent(agentIdArg);
    if (!agent) fail(`No agent with id "${agentIdArg}".`);
    return agent;
  }
  const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
  if (!agents.length) fail('No agents in the database. Call POST /api/agent/init first.');
  if (agents.length > 1) {
    console.log(`No agentId given — using the most recent (${agents[0].id}). Others: ${agents.slice(1).map((a) => a.id).join(', ')}`);
  }
  return agents[0];
}

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const bar = (n) => '='.repeat(n);

async function main() {
  const agent = resolveAgent();
  const persona = loadPersona(agent);

  const posts = db
    .prepare('SELECT id, title, text, created_at FROM posts WHERE agent_id = ? ORDER BY rowid DESC LIMIT ?')
    .all(agent.id, COUNT);

  if (posts.length < 2) {
    fail(`Only ${posts.length} post(s) published so far — need at least 2 to review consistency. Let the agent run, or POST /api/agent/trigger.`);
  }

  console.log(`\n${bar(72)}`);
  console.log(`  VOICE REVIEW — ${persona.name}, ${persona.role}`);
  console.log(`  agent ${agent.id} · beat "${persona.domain}" · ${posts.length} most recent posts`);
  console.log(bar(72));

  /* ------------------------------ pass 1: lint ------------------------------ */

  console.log('\n  PASS 1 — deterministic style lint\n');
  let lintFailures = 0;

  for (const [i, post] of posts.entries()) {
    const lint = lintVoice(post.text, persona);
    const label = `  ${i + 1}. ${post.id}  ${lint.words} words`;
    if (lint.ok) {
      console.log(`${label}  ok`);
    } else {
      lintFailures++;
      console.log(`${label}  FAIL`);
      for (const p of lint.problems) console.log(`       - ${p}`);
    }
  }

  /* --------------------------- pass 2: LLM review --------------------------- */

  console.log('\n  PASS 2 — style-guide review against the persona config\n');

  const numbered = posts
    .map((p, i) => `--- POST ${i + 1} (${p.id}, ${(p.created_at || '').slice(0, 10)}) ---\n${p.text}`)
    .join('\n\n');

  const prompt = `Below are ${posts.length} posts published by this persona. Review them against the
style guide in your system prompt — the voice description, the beat, and the standing
positions. You are auditing, not writing: be exacting, and say plainly where the voice
slips rather than being generous.

${numbered}

Score each post 0-100 on:
- voiceMatch:  sentence length, formality, jargon level, and humor as the guide specifies
- beatFit:     does the subject sit inside the topics this persona covers
- authenticity: does it read as a specific person with views, or as generic AI commentary

Then judge the set as a whole: could these plausibly have been written by one person in
one week, or do they drift in tone, structure, or opening move?

Return ONLY JSON:
{
  "posts": [
    { "index": 1, "voiceMatch": <int>, "beatFit": <int>, "authenticity": <int>,
      "verdict": "<one sentence on how well it matches the persona>",
      "slips": ["<specific quoted phrase or structural habit that breaks voice; empty array if none>"] }
  ],
  "consistency": { "score": <int>, "assessment": "<2-3 sentences on whether these read as one person, naming any drift>" },
  "repetition": "<one sentence: do any posts reuse the same opening move, closing move, or argument structure?>",
  "recommendation": "<one concrete change to the persona config or the writing prompt that would tighten the voice>"
}`;

  const { data } = await completeJSON({
    system: personaSystemPrompt(persona),
    prompt,
    maxTokens: 4000,
    effort: 'medium',
    label: 'voice-check',
  });

  let lowScores = 0;
  for (const r of data.posts || []) {
    const post = posts[r.index - 1];
    const avg = Math.round(((r.voiceMatch || 0) + (r.beatFit || 0) + (r.authenticity || 0)) / 3);
    if (avg < PASS_MARK) lowScores++;
    console.log(`  ${r.index}. ${post?.id || '?'}  voice ${r.voiceMatch}  beat ${r.beatFit}  authenticity ${r.authenticity}   avg ${avg}${avg < PASS_MARK ? '  BELOW PASS' : ''}`);
    console.log(`       ${r.verdict}`);
    for (const s of r.slips || []) console.log(`       slip: ${s}`);
    console.log('');
  }

  console.log(`  CONSISTENCY: ${data.consistency?.score ?? '?'}/100`);
  console.log(`  ${data.consistency?.assessment || '(none)'}\n`);
  console.log(`  REPETITION: ${data.repetition || '(none)'}\n`);
  console.log(`  RECOMMENDATION: ${data.recommendation || '(none)'}`);

  /* --------------------------------- verdict -------------------------------- */

  const consistency = data.consistency?.score ?? 0;
  const passed = lintFailures === 0 && lowScores === 0 && consistency >= PASS_MARK;

  console.log(`\n${bar(72)}`);
  console.log(
    `  ${passed ? 'PASS' : 'FAIL'} — ${lintFailures} lint failure(s), ` +
      `${lowScores} post(s) below ${PASS_MARK}, consistency ${consistency}/100`
  );
  console.log(`${bar(72)}\n`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Voice check failed: ${err.message}\n`);
  process.exit(1);
});
