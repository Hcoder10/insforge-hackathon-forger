#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BENCH = path.join(ROOT, 'bench');
const tasks = require(path.join(BENCH, 'tasks'));
const { buildFlatPrompt } = require(path.join(BENCH, 'bench', 'prompt'));
const { evalSubmission } = require(path.join(BENCH, 'bench', 'eval_submission'));
const { repairSolution } = require('./repair_solution');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forger-repair-null-'));
  const subPath = path.join(dir, 'sub_null_repair.json');
  const scorePath = path.join(dir, 'score_null_repair.json');
  const sub = {
    model: 'null-output-plus-repair',
    meta: { audit: 'empty model output passed through optimizer/eval/repair_solution.js' },
    solutions: {},
  };

  let repaired = 0;
  for (const task of tasks.TEST) {
    const code = repairSolution(task.id, buildFlatPrompt(task), '');
    if (code) repaired += 1;
    sub.solutions[task.id] = code;
  }

  fs.writeFileSync(subPath, JSON.stringify(sub, null, 2) + '\n');
  const out = await evalSubmission(subPath, scorePath);
  const summary = {
    repaired,
    total: tasks.TEST.length,
    pass: out.agg.pass,
    score: out.agg.meanScore,
    eff: out.agg.meanEff,
    verdict: out.agg.meanScore >= 100
      ? 'REPAIR_LAYER_CAN_SOLVE_SEALED_TASKS_WITHOUT_MODEL_OUTPUT'
      : 'repair layer did not solve all sealed tasks',
    scorePath,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
