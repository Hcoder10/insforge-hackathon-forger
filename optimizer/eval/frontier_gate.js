#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

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

function resolveFile(file, fallback) {
  if (!file) return fallback;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function isRepairLabeled(data) {
  const text = `${data.model || ''} ${data.status || ''}`.toLowerCase();
  return text.includes('repair');
}

function main() {
  const opts = parse(process.argv.slice(2));
  const file = resolveFile(opts.file, path.join(ROOT, 'optimizer', 'results', 'frontier_run.json'));
  const data = readJson(file);
  const failures = [];
  const score = Number(data.score);
  const baseline = Number(data.baselineScore);

  if (!Number.isFinite(score)) failures.push('score is not numeric');
  if (!Number.isFinite(baseline)) failures.push('baselineScore is not numeric');
  if (isRepairLabeled(data)) failures.push('artifact is repair-labeled; raw model gate requires no repair layer');
  if (Number.isFinite(score) && Number.isFinite(baseline) && score <= baseline) {
    failures.push(`raw score ${score} does not beat baseline ${baseline}`);
  }

  const summary = {
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    model: data.model,
    status: data.status,
    score,
    baseline,
    delta: Number.isFinite(score) && Number.isFinite(baseline)
      ? Math.round((score - baseline) * 10) / 10
      : null,
    pass: failures.length === 0,
    failures,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exit(1);
}
