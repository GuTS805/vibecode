#!/usr/bin/env node
/**
 * Initialize every persona in the registry against a running server.
 *
 *   npm run seed                          # all personas, against localhost:3000
 *   npm run seed -- --url https://…       # against a deployed instance
 *   npm run seed -- Ada Ellis             # only the named ones
 *
 * This is a convenience wrapper around POST /api/agent/init — it makes exactly the call a
 * reviewer would make by hand, once per persona, and prints the agent ids. Each agent is
 * autonomous from that point; nothing here stays running.
 */

import { listRegistryPersonas } from '../src/persona.js';

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const BASE = (urlFlag !== -1 ? args[urlFlag + 1] : 'http://localhost:3000').replace(/\/$/, '');
const wanted = args.filter((a, i) => !a.startsWith('--') && i !== urlFlag + 1).map((s) => s.toLowerCase());

const all = listRegistryPersonas();
const selected = wanted.length ? all.filter((p) => wanted.includes(p.name.toLowerCase())) : all;

if (!selected.length) {
  console.error(`\n  No matching personas. Available: ${all.map((p) => p.name).join(', ')}\n`);
  process.exit(1);
}

console.log(`\n  Initializing ${selected.length} persona(s) against ${BASE}\n`);

const results = [];
let failures = 0;

for (const persona of selected) {
  try {
    const res = await fetch(`${BASE}/api/agent/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: { name: persona.name, domain: persona.domain } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    results.push({ ...persona, agentId: body.agentId });
    console.log(`  ${persona.name.padEnd(8)} ${persona.domain.padEnd(12)} -> ${body.agentId}`);
  } catch (err) {
    failures++;
    console.log(`  ${persona.name.padEnd(8)} ${persona.domain.padEnd(12)} -> FAILED: ${err.message}`);
  }
}

if (failures === selected.length) {
  console.error(`\n  Nothing was initialized. Is the server running at ${BASE}? Start it with: npm start\n`);
  process.exit(1);
}

console.log(`\n  Done. ${results.length} agent(s) live.`);

// Report the cadence the server actually derived — it stretches with roster size to stay
// inside the daily call budget, so a fixed number printed here would be wrong.
if (results[0]) {
  try {
    const res = await fetch(`${BASE}/api/agent/status?agentId=${results[0].agentId}`);
    const status = await res.json();
    if (status.cycleCadence) console.log(`  Cadence: ${status.cycleCadence}`);
  } catch { /* cosmetic only */ }
  console.log(`  First cycles are staggered a few minutes apart so they don't rate-limit each other.`);
  console.log(`\n  Watch them at ${BASE}, or poll a feed:\n`);
  console.log(`    curl "${BASE}/api/agent/feed?agentId=${results[0].agentId}"\n`);
}

if (failures) process.exit(1);
