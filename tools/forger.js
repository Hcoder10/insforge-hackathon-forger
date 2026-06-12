#!/usr/bin/env node
// FORGER command runner.
//
// branch-review is intentionally recorded-mode by default. Live mode creates and switches
// InsForge backend branches, so callers must opt in with --live.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BENCH = path.join(ROOT, 'bench');
const WORKLOADS = path.join(BENCH, 'workloads');
const DEFAULT_RECORD = path.join(BENCH, 'results', 'branch-review');

function usage() {
  console.log(`FORGER

usage:
  node tools/forger.js branch-review --scenario <name> [--record <dir>] [--branch <name>] [--mode schema-only|full] [--live] [--keep-branch]
  node tools/forger.js frontier-validate --file <frontier_run.json>

examples:
  node tools/forger.js branch-review --scenario slow-query-index
  node tools/forger.js branch-review --scenario slow-query-index --live --branch forger-demo --mode schema-only
`);
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['live', 'recorded', 'keep-branch', 'yes'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function loadWorkload(name) {
  const file = path.join(WORKLOADS, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`unknown workload: ${name}`);
  return readJson(file);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${res.stderr || res.stdout}`);
  }
  return res;
}

function runInsforge(args, opts = {}) {
  return run('npx', ['--yes', '@insforge/cli', ...args], opts);
}

function runDbQuery(sql) {
  const { dbQuery } = require(path.join(BENCH, 'live', 'dbquery'));
  return dbQuery(sql);
}

function captureLivePlan(sql) {
  const { capturePlan } = require(path.join(BENCH, 'live', 'explain'));
  const plan = capturePlan(sql);
  return { cpuTimeMs: plan.actualTimeMs || 0, ...plan };
}

function pctChange(base, next) {
  if (base === 0 && next === 0) return 0;
  if (base === 0) return 100;
  return ((next - base) / base) * 100;
}

function metricSummary(base, next) {
  const keys = ['actualTimeMs', 'cpuTimeMs', 'diskBytes', 'memoryBytes', 'seqScans'];
  return Object.fromEntries(keys.map((k) => [k, {
    baseline: metricValue(base, k),
    candidate: metricValue(next, k),
    delta: metricValue(next, k) - metricValue(base, k),
    pct: pctChange(metricValue(base, k), metricValue(next, k)),
  }]));
}

function metricValue(summary, key) {
  if (summary[key] !== undefined) return Number(summary[key]) || 0;
  if (key === 'cpuTimeMs') return Number(summary.actualTimeMs) || 0;
  return 0;
}

function verdict(workload, baseline, candidate) {
  const t = workload.thresholds || {};
  const diff = metricSummary(baseline, candidate);
  const failures = [];
  const warnings = [];

  if (workload.correctness?.expectedMinRows && (candidate.actualRows || 0) < workload.correctness.expectedMinRows) {
    failures.push(`candidate returned ${candidate.actualRows || 0} rows, expected at least ${workload.correctness.expectedMinRows}`);
  }
  if (typeof t.seqScansMax === 'number' && (candidate.seqScans || 0) > t.seqScansMax) {
    failures.push(`candidate seqScans ${candidate.seqScans || 0} exceeds ${t.seqScansMax}`);
  }
  for (const [metric, limitKey] of [
    ['actualTimeMs', 'actualTimeMsMaxIncreasePct'],
    ['cpuTimeMs', 'cpuTimeMsMaxIncreasePct'],
    ['diskBytes', 'diskBytesMaxIncreasePct'],
    ['memoryBytes', 'memoryBytesMaxIncreasePct'],
  ]) {
    if (typeof t[limitKey] === 'number' && diff[metric].pct > t[limitKey]) {
      failures.push(`${metric} increased ${diff[metric].pct.toFixed(1)}%`);
    }
    if (diff[metric].pct > 0) warnings.push(`${metric} increased ${diff[metric].pct.toFixed(1)}%`);
  }

  const status = failures.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { status, failures, warnings, metrics: diff };
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n || 0), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function annotateSql(workload, result) {
  const lines = [];
  lines.push('-- FORGER annotated merge preview');
  lines.push(`-- Workload: ${workload.name}`);
  lines.push(`-- Verdict: ${result.verdict.status.toUpperCase()}`);
  for (const [metric, d] of Object.entries(result.verdict.metrics)) {
    const b = metric.includes('Bytes') ? formatBytes(d.baseline) : d.baseline.toFixed ? d.baseline.toFixed(2) : d.baseline;
    const c = metric.includes('Bytes') ? formatBytes(d.candidate) : d.candidate.toFixed ? d.candidate.toFixed(2) : d.candidate;
    lines.push(`-- ${metric}: ${b} -> ${c} (${d.pct.toFixed(1)}%)`);
  }
  lines.push('');
  lines.push((result.mergeSql || workload.candidate?.migration || '-- no merge SQL captured').trim());
  lines.push('');
  return lines.join('\n');
}

function markdownReport(workload, result) {
  const rows = Object.entries(result.verdict.metrics).map(([k, d]) => {
    const base = k.includes('Bytes') ? formatBytes(d.baseline) : String(Number(d.baseline).toFixed ? Number(d.baseline).toFixed(2) : d.baseline);
    const cand = k.includes('Bytes') ? formatBytes(d.candidate) : String(Number(d.candidate).toFixed ? Number(d.candidate).toFixed(2) : d.candidate);
    return `| ${k} | ${base} | ${cand} | ${d.pct.toFixed(1)}% |`;
  }).join('\n');
  return `# FORGER Branch Review: ${workload.name}

Status: **${result.verdict.status.toUpperCase()}**

Branch: \`${result.branch.name}\`  
Mode: \`${result.branch.mode}\`  
Execution: \`${result.executionMode}\`

## Resource Diff

| Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|
${rows}

## Findings

${[...result.verdict.failures, ...result.verdict.warnings].map((x) => `- ${x}`).join('\n') || '- No blocking resource regressions.'}

## Candidate Change

\`\`\`sql
${(result.mergeSql || workload.candidate?.migration || '').trim()}
\`\`\`

## Timeline

${result.timeline.map((e) => `- ${e.status.toUpperCase()}: ${e.label}`).join('\n')}
`;
}

function recordedPlans(workload) {
  if (!workload.recorded?.baselinePlan || !workload.recorded?.candidatePlan) {
    throw new Error(`workload ${workload.name} has no recorded plans`);
  }
  return {
    baseline: workload.recorded.baselinePlan,
    candidate: workload.recorded.candidatePlan,
    mergeSql: workload.recorded.mergeSql || workload.candidate?.migration || '',
  };
}

function runLiveBranchReview(workload, opts, timeline) {
  const branch = opts.branch || `forger-${workload.name}`.slice(0, 54);
  const mode = opts.mode || workload.branchMode || 'schema-only';

  timeline.push({ status: 'ok', label: `creating branch ${branch}` });
  runInsforge(['branch', 'create', branch, '--mode', mode]);

  try {
    for (const sql of workload.setup?.sql || []) {
      timeline.push({ status: 'ok', label: 'applying setup SQL' });
      runDbQuery(sql);
    }
    timeline.push({ status: 'ok', label: 'capturing baseline plan on branch' });
    const baseline = captureLivePlan(workload.baselineSql);

    if (workload.candidate?.migration) {
      timeline.push({ status: 'ok', label: 'applying candidate migration' });
      runDbQuery(workload.candidate.migration);
    }

    timeline.push({ status: 'ok', label: 'capturing candidate plan on branch' });
    const candidate = captureLivePlan(workload.candidateSql || workload.baselineSql);

    const mergePath = path.join(opts.record, 'merge-preview.sql');
    timeline.push({ status: 'ok', label: 'capturing branch merge dry-run SQL' });
    const merge = runInsforge(['branch', 'merge', branch, '--dry-run', '--save-sql', mergePath], { allowFailure: true });
    const mergeSql = fs.existsSync(mergePath) ? fs.readFileSync(mergePath, 'utf8') : (merge.stdout || merge.stderr || workload.candidate?.migration || '');

    return { branch: { name: branch, mode }, baseline, candidate, mergeSql };
  } finally {
    if (!opts.keepBranch) {
      timeline.push({ status: 'ok', label: `deleting branch ${branch}` });
      runInsforge(['branch', 'delete', branch, '-y'], { allowFailure: true });
    } else {
      timeline.push({ status: 'warn', label: `kept branch ${branch}` });
    }
  }
}

function runBranchReview(opts) {
  const scenario = opts.scenario || opts._[1];
  if (!scenario) throw new Error('branch-review requires --scenario <name>');
  const workload = loadWorkload(scenario);
  const record = path.resolve(opts.record || path.join(DEFAULT_RECORD, scenario));
  mkdirp(record);

  const timeline = [{ status: 'ok', label: `loaded workload ${workload.name}` }];
  const executionMode = opts.live ? 'live-insforge-branch' : 'recorded';
  const branch = { name: opts.branch || `forger-${workload.name}`.slice(0, 54), mode: opts.mode || workload.branchMode || 'schema-only' };

  let plans;
  if (opts.live) {
    plans = runLiveBranchReview(workload, { ...opts, record }, timeline);
  } else {
    timeline.push({ status: 'ok', label: 'using recorded branch evidence' });
    plans = { branch, ...recordedPlans(workload) };
  }

  const v = verdict(workload, plans.baseline, plans.candidate);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workload: { name: workload.name, kind: workload.kind, description: workload.description },
    executionMode,
    branch: plans.branch || branch,
    baseline: plans.baseline,
    candidate: plans.candidate,
    verdict: v,
    mergeSql: plans.mergeSql,
    timeline,
  };

  writeJson(path.join(record, 'result.json'), result);
  fs.writeFileSync(path.join(record, 'report.md'), markdownReport(workload, result));
  fs.writeFileSync(path.join(record, 'annotated-merge.sql'), annotateSql(workload, result));
  writeJson(path.join(record, 'timeline.json'), timeline);

  console.log(`FORGER branch review ${v.status.toUpperCase()}: ${workload.name}`);
  console.log(`  wrote ${path.relative(ROOT, path.join(record, 'result.json'))}`);
  return result;
}

function validateFrontier(opts) {
  const file = opts.file;
  if (!file) throw new Error('frontier-validate requires --file <json>');
  const data = readJson(path.resolve(file));
  const missing = [];
  for (const k of ['model', 'generatedAt', 'score', 'passRate', 'baselineScore', 'tasks']) {
    if (!(k in data)) missing.push(k);
  }
  if (missing.length) throw new Error(`frontier artifact missing: ${missing.join(', ')}`);
  if (!Array.isArray(data.tasks)) throw new Error('frontier artifact tasks must be an array');
  console.log(`FRONTIER_ARTIFACT_OK ${data.model} score=${data.score} baseline=${data.baselineScore}`);
}

function main() {
  const opts = parse(process.argv.slice(2));
  const cmd = opts._[0];
  try {
    if (cmd === 'branch-review') runBranchReview(opts);
    else if (cmd === 'frontier-validate') validateFrontier(opts);
    else { usage(); process.exit(cmd ? 1 : 0); }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadWorkload, verdict, metricSummary, runBranchReview };
