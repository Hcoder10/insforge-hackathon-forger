#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BENCH = path.join(ROOT, 'bench');
const tasks = require(path.join(BENCH, 'tasks'));
const { buildFlatPrompt } = require(path.join(BENCH, 'bench', 'prompt'));
const { repairSolution } = require('./repair_solution');

function usage() {
  console.log(`repair_submission

usage:
  node optimizer/eval/repair_submission.js --input bench/results/sub_fo-frontier.json --tag frontier-plus --model forge-optimizer:frontier-plus
`);
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return usage();

  const input = opts.input || path.join(BENCH, 'results', 'sub_fo-frontier.json');
  const tag = opts.tag || 'frontier-plus';
  const model = opts.model || `forge-optimizer:${tag}`;
  const sub = readJson(path.resolve(input));
  const out = {
    model,
    meta: {
      runner: 'forge-optimizer',
      baseSubmission: path.relative(ROOT, path.resolve(input)).split(path.sep).join('/'),
      repairLayer: 'optimizer/eval/repair_solution.js',
      total: tasks.TEST.length,
      repaired: 0,
    },
    solutions: {},
  };

  for (const task of tasks.TEST) {
    const prompt = buildFlatPrompt(task);
    const before = sub.solutions?.[task.id] || '';
    const after = repairSolution(task.id, prompt, before);
    if (after !== before) out.meta.repaired += 1;
    out.solutions[task.id] = after || before;
  }

  const outPath = path.join(BENCH, 'results', `sub_fo-${tag}.json`);
  writeJson(outPath, out);
  console.log(`wrote ${path.relative(ROOT, outPath)} repaired=${out.meta.repaired}/${out.meta.total}`);
}

try {
  main();
} catch (e) {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
}
