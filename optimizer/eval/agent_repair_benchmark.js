#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BENCH = path.join(ROOT, 'bench');
const RESULTS = path.join(BENCH, 'results');
const OUT = path.join(ROOT, 'optimizer', 'results', 'agent_repair_benchmark.json');
const tasks = require(path.join(BENCH, 'tasks'));
const { buildFlatPrompt } = require(path.join(BENCH, 'bench', 'prompt'));
const { evalSubmission } = require(path.join(BENCH, 'bench', 'eval_submission'));
const { repairAgentCode } = require('./agent_code_repair');

const DEFAULT_INPUTS = [
  'sub_codex.json',
  'sub_claude.json',
  'sub_gemini.json',
  'sub_gpt-oss-120b.json',
  'sub_nemotron-3-super.json',
  'sub_qwen3.6.json',
  'sub_devin.json',
  'sub_fo-frontier.json',
];

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

function existingScoreFor(subFile) {
  const scoreName = path.basename(subFile).replace(/^sub_/, 'score_');
  const scoreFile = path.join(RESULTS, scoreName);
  return fs.existsSync(scoreFile) ? readJson(scoreFile) : null;
}

async function scoreSubmission(subPath, maybeExistingScore) {
  if (maybeExistingScore) return maybeExistingScore;
  const tmpScore = subPath.replace(/sub_/, 'score_');
  return evalSubmission(subPath, tmpScore);
}

function emptyGuard() {
  let repaired = 0;
  for (const task of tasks.TEST) {
    const out = repairAgentCode(task.id, buildFlatPrompt(task), '');
    if (out.repaired || String(out.code || '').trim()) repaired += 1;
  }
  return { repaired, total: tasks.TEST.length, passed: repaired === 0 };
}

function byId(records) {
  return new Map((records || []).map((r) => [r.id, r]));
}

async function runOne(subFile, opts) {
  const sourcePath = path.join(RESULTS, subFile);
  const source = readJson(sourcePath);
  const before = await scoreSubmission(sourcePath, existingScoreFor(sourcePath));
  const repaired = {
    model: `${source.model || subFile.replace(/^sub_|\.json$/g, '')}+agent-code-repair`,
    meta: {
      repairEngine: 'optimizer/eval/agent_code_repair.js',
      sourceSubmission: `bench/results/${subFile}`,
      requiresAgentCode: true,
    },
    solutions: {},
  };

  const repairStats = { repaired: 0, skipped: 0, reasons: {} };
  for (const task of tasks.TEST) {
    const prompt = buildFlatPrompt(task);
    const input = source.solutions?.[task.id] || '';
    const out = repairAgentCode(task.id, prompt, input);
    repaired.solutions[task.id] = out.code || input;
    if (out.repaired) repairStats.repaired += 1;
    else repairStats.skipped += 1;
    repairStats.reasons[out.reason] = (repairStats.reasons[out.reason] || 0) + 1;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forger-agent-repair-'));
  const repairedPath = path.join(tmpDir, subFile.replace(/^sub_/, 'sub_repaired_'));
  const repairedScorePath = path.join(tmpDir, subFile.replace(/^sub_/, 'score_repaired_'));
  writeJson(repairedPath, repaired);
  const after = await evalSubmission(repairedPath, repairedScorePath);
  const beforeById = byId(before.records);
  const afterById = byId(after.records);
  const fixed = [];
  const regressions = [];
  for (const task of tasks.TEST) {
    const b = beforeById.get(task.id);
    const a = afterById.get(task.id);
    if (b && a && !b.correct && a.correct) fixed.push(task.id);
    if (b && a && b.correct && !a.correct) regressions.push(task.id);
  }

  if (opts.keepSubmissions) {
    writeJson(path.join(RESULTS, path.basename(repairedPath)), repaired);
    writeJson(path.join(RESULTS, path.basename(repairedScorePath)), after);
  }

  return {
    source: subFile,
    model: source.model || subFile,
    before: {
      pass: before.agg.pass,
      score: before.agg.meanScore,
      eff: before.agg.meanEff,
    },
    after: {
      pass: after.agg.pass,
      score: after.agg.meanScore,
      eff: after.agg.meanEff,
    },
    delta: Math.round((after.agg.meanScore - before.agg.meanScore) * 10) / 10,
    repairStats,
    fixedFailures: fixed,
    regressions,
  };
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const inputs = (opts.inputs ? String(opts.inputs).split(',') : DEFAULT_INPUTS)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(RESULTS, f)));
  const guard = emptyGuard();
  const models = [];
  for (const subFile of inputs) models.push(await runOne(subFile, opts));

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repairEngine: 'optimizer/eval/agent_code_repair.js',
    claim: 'code-aware repair over saved frontier agent submissions',
    emptyGuard: guard,
    modelCount: models.length,
    averageBefore: mean(models, (m) => m.before.score),
    averageAfter: mean(models, (m) => m.after.score),
    totalFixedFailures: models.reduce((sum, m) => sum + m.fixedFailures.length, 0),
    totalRegressions: models.reduce((sum, m) => sum + m.regressions.length, 0),
    models,
  };
  writeJson(opts.out ? path.resolve(opts.out) : OUT, summary);
  console.log(JSON.stringify({
    emptyGuard: guard,
    models: summary.modelCount,
    averageBefore: summary.averageBefore,
    averageAfter: summary.averageAfter,
    fixedFailures: summary.totalFixedFailures,
    regressions: summary.totalRegressions,
    out: path.relative(ROOT, opts.out ? path.resolve(opts.out) : OUT),
  }, null, 2));

  if (!guard.passed) {
    console.error('ERR agent repair empty-output guard failed');
    process.exit(1);
  }
  if (summary.totalRegressions > 0) {
    console.error('ERR agent repair caused regressions');
    process.exit(1);
  }
}

function mean(items, fn) {
  const vals = items.map(fn).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
