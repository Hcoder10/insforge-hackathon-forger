// forge-optimizer — contamination gate. MUST pass before any training run.
// Asserts: (1) no training example mentions a forger-bench TEST entity (table name),
//          (2) held-out concepts never appear in training data,
//          (3) no training prompt equals a test task prompt.
'use strict';

const fs = require('fs');
const path = require('path');
const FB = path.join(__dirname, '..', '..', 'forger-bench');
const tasks = require(path.join(FB, 'tasks'));

function testEntities() {
  // table names used by any sealed test task — the FORBIDDEN set
  const set = new Set();
  for (const t of tasks.TEST) {
    const src = `${t.oracle}\n${t.naive}\n${t.prompt}`;
    for (const m of src.matchAll(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/gi)) set.add(m[1]);
  }
  return set;
}

function main() {
  const outDir = process.argv[2] || path.join(__dirname, 'out');
  const sft = fs.readFileSync(path.join(outDir, 'sft.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const forbidden = testEntities();
  const heldOut = new Set(manifest.heldOut);
  const testPrompts = new Set(tasks.TEST.map((t) => t.prompt));

  let problems = 0;
  console.log('CONTAMINATION GATE');
  console.log('-'.repeat(50));

  // 1. no test entity in any training example
  let leaks = 0;
  for (const ex of sft) {
    const text = ex.messages.map((m) => m.content).join('\n');
    for (const ent of forbidden) {
      // word-boundary match on .from('ent') or 'ent' table refs
      if (new RegExp(`\\bfrom\\(['"]${ent}['"]`).test(text)) { leaks++; break; }
    }
  }
  if (leaks) { problems += leaks; console.log(`  LEAK: ${leaks} training examples reference a TEST entity`); }
  else console.log(`  OK: 0 of ${sft.length} examples reference any of ${forbidden.size} test entities`);

  // 2. held-out concepts absent
  const trainedConcepts = new Set(sft.map((x) => x.meta.concept));
  const ho = [...heldOut].filter((c) => trainedConcepts.has(c));
  if (ho.length) { problems += ho.length; console.log(`  LEAK: held-out concept(s) in training: ${ho.join(', ')}`); }
  else console.log(`  OK: held-out concepts (${[...heldOut].join(', ')}) absent from training`);

  // 3. no exact test prompt in training
  let pdup = 0;
  for (const ex of sft) { const u = ex.messages.find((m) => m.role === 'user'); if (u && testPrompts.has(u.content)) pdup++; }
  if (pdup) { problems += pdup; console.log(`  LEAK: ${pdup} training prompts equal a test prompt`); }
  else console.log(`  OK: no training prompt matches a test prompt`);

  console.log('-'.repeat(50));
  console.log(problems === 0 ? 'CONTAMINATION_CLEAN' : `CONTAMINATION_FAILED (${problems})`);
  process.exit(problems === 0 ? 0 : 1);
}

main();
