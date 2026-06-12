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
    const key = a.slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
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

function resolveFile(file, fallback) {
  if (!file) return fallback;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function mean(records, fn) {
  const vals = records.map(fn).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function summarizeMetrics(score) {
  const records = score.records || [];
  return {
    avgCpuOps: mean(records, (r) => Number(r.metrics?.cpuOps)),
    avgDiskBytes: mean(records, (r) => Number(r.metrics?.diskBytes)),
    avgMemoryBytes: mean(records, (r) => Number(r.metrics?.memoryBytes)),
    avgWallMs: mean(records, (r) => Number(r.metrics?.wallMs)),
    avgCpuTotalMs: mean(records, (r) => Number(r.metrics?.cpuTotalMs)),
    avgPeakRSS: mean(records, (r) => Number(r.metrics?.peakRSS)),
  };
}

function domainTasks(score) {
  const domains = score.agg?.domains || {};
  return Object.entries(domains).map(([name, d]) => ({
    name,
    before: null,
    after: round(d.meanScore ?? d.pass ?? 0),
    passRate: round(d.pass ?? 0),
  }));
}

function repoPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function round(n) {
  return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10) / 10 : null;
}

function buildReport(score, baseline, opts) {
  const model = opts.model || score.model || 'forge-optimizer-frontier';
  const agg = score.agg || {};
  const baselineAgg = baseline?.agg || {};
  const scoreValue = round(agg.meanScore ?? agg.pass ?? 0);
  const baselineScore = round(Number(opts['baseline-score']) || baselineAgg.meanScore || baselineAgg.pass || 0);
  const tasks = domainTasks(score);

  return {
    schemaVersion: 1,
    model,
    generatedAt: new Date().toISOString(),
    status: opts.status || 'live-run',
    recorded: false,
    score: scoreValue,
    passRate: round(agg.pass ?? 0),
    baselineModel: baseline?.model || opts['baseline-model'] || 'baseline',
    baselineScore,
    delta: round(scoreValue - baselineScore),
    taskCount: agg.n || score.records?.length || 0,
    tasks,
    resourceMeans: summarizeMetrics(score),
    source: {
      scoreFile: repoPath(opts.scoreFile),
      baselineFile: baseline ? repoPath(opts.baselineFile) : null,
    },
  };
}

function usage() {
  console.log(`frontier_report

usage:
  node optimizer/eval/frontier_report.js --score bench/results/score_fo-frontier.json --baseline bench/results/score_codex.json --out optimizer/results/frontier_run.json
`);
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return usage();

  const scoreFile = resolveFile(opts.score, path.join(ROOT, 'bench', 'results', 'score_fo-frontier.json'));
  const baselineFile = resolveFile(opts.baseline, path.join(ROOT, 'bench', 'results', 'score_codex.json'));
  const outFile = resolveFile(opts.out, path.join(ROOT, 'optimizer', 'results', 'frontier_run.json'));

  if (!fs.existsSync(scoreFile)) {
    throw new Error(`score file not found: ${scoreFile}`);
  }

  const score = readJson(scoreFile);
  const baseline = fs.existsSync(baselineFile) ? readJson(baselineFile) : null;
  const report = buildReport(score, baseline, { ...opts, scoreFile, baselineFile });
  writeJson(outFile, report);
  console.log(`wrote ${path.relative(ROOT, outFile)} score=${report.score} baseline=${report.baselineScore}`);
}

try {
  main();
} catch (e) {
  console.error('ERR', e.message);
  process.exit(1);
}
