// forger-bench — grade a submission against the sealed test split.
//
// A submission is results/sub_<model>.json: { model, solutions: { taskId: code }, meta }.
// Grades each test task via the harness, writes results/score_<model>.json, prints the
// headline (Pass / Score / Eff / Gap) + per-domain breakdown.
//
// usage: node bench/eval_submission.js results/sub_<model>.json [results/score_<model>.json]

'use strict';

const fs = require('fs');
const path = require('path');
const tasks = require('../tasks');
const { gradeSolution } = require('./harness');
const { aggregate } = require('./score');

async function evalSubmission(subPath, outPath) {
  const sub = JSON.parse(fs.readFileSync(subPath, 'utf8'));
  const solutions = sub.solutions || {};
  const records = [];
  for (const task of tasks.TEST) {
    const code = solutions[task.id];
    if (!code) {
      records.push({ id: task.id, domain: task.domain, concept: task.concept, correct: false, score: 0, eff: 0, error: 'no solution' });
      continue;
    }
    const g = await gradeSolution(task, code);
    records.push(g);
  }
  const agg = aggregate(records);
  const out = { model: sub.model, meta: sub.meta || {}, agg, records };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  return out;
}

function printScore(out) {
  const a = out.agg;
  console.log(`\nMODEL: ${out.model}`);
  console.log(`  Pass:  ${a.pass.toFixed(1)}%   Score: ${a.meanScore.toFixed(1)}   Eff: ${(a.meanEff * 100).toFixed(1)}%   Gap: ${a.gap.toFixed(1)}`);
  console.log('  per-domain:');
  for (const [d, v] of Object.entries(a.domains)) {
    console.log(`    ${d.padEnd(8)} n=${String(v.n).padStart(2)}  pass=${v.pass.toFixed(0).padStart(3)}%  score=${v.meanScore.toFixed(1).padStart(5)}  eff=${(v.meanEff * 100).toFixed(0).padStart(3)}%`);
  }
  // failing concepts
  const fails = out.records.filter((r) => !r.correct).map((r) => r.id);
  if (fails.length) console.log(`  FAILED (${fails.length}): ${fails.join(', ')}`);
}

async function main() {
  const subPath = process.argv[2];
  if (!subPath) { console.error('usage: node bench/eval_submission.js <sub.json> [score.json]'); process.exit(1); }
  const outPath = process.argv[3] || subPath.replace(/sub_/, 'score_').replace(/([^/\\]+)$/, (m) => m.startsWith('score_') ? m : 'score_' + m.replace('sub_', ''));
  const out = await evalSubmission(subPath, outPath);
  printScore(out);
  console.log(`\nwrote ${outPath}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { evalSubmission, printScore };
