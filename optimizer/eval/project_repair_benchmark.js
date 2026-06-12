#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackend } = require('../../bench/mock');
const { repairProject } = require('./project_code_repair');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'optimizer', 'fixtures', 'agent_projects');
const OUT = path.join(ROOT, 'optimizer', 'results', 'project_repair_benchmark.json');

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

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function requireFresh(file) {
  delete require.cache[require.resolve(file)];
  return require(file);
}

function seedRows(be, t, n, titleCol, bodyCol = 'body') {
  be.admin.createTable(t);
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: `${t}_${i}`, [titleCol]: `${titleCol} ${i}`, [bodyCol]: 'x'.repeat(200), created_at: i });
  }
  be.admin.seed(t, rows);
}

function checkMax(metrics, max = {}) {
  const failures = [];
  for (const [key, limit] of Object.entries(max)) {
    if (Number(metrics[key] || 0) > Number(limit)) failures.push(`${key}=${metrics[key]} > ${limit}`);
  }
  return failures;
}

async function runCase(projectRoot, testCase) {
  const be = createBackend();
  const mod = requireFresh(path.join(projectRoot, testCase.module));
  const fn = mod[testCase.exportName];
  if (typeof fn !== 'function') throw new Error(`missing export ${testCase.exportName}`);

  let result;
  let error = null;
  try {
    result = await runByKind(be, fn, testCase);
  } catch (e) {
    error = e;
  }

  const correctnessFailures = error ? [String(error.message || error)] : verifyByKind(be, testCase, result);
  const efficiencyFailures = correctnessFailures.length ? [] : checkMax(be.metrics, testCase.maxMetrics);
  return {
    name: testCase.name,
    module: testCase.module,
    exportName: testCase.exportName,
    kind: testCase.kind,
    correct: correctnessFailures.length === 0,
    efficient: correctnessFailures.length === 0 && efficiencyFailures.length === 0,
    result,
    error: error ? String(error.message || error) : null,
    correctnessFailures,
    efficiencyFailures,
    metrics: be.metrics,
  };
}

async function runByKind(be, fn, testCase) {
  const cfg = testCase.config || {};
  if (testCase.kind === 'db.pagination') {
    seedRows(be, cfg.table, cfg.total, cfg.titleCol);
    return fn(be.insforge);
  }
  if (testCase.kind === 'storage.listMeta') {
    be.admin.createBucket(cfg.bucket);
    for (let i = 1; i <= cfg.count; i++) be.admin.putFile(cfg.bucket, `f-${i}.bin`, cfg.bytesEach);
    return fn(be.insforge);
  }
  if (testCase.kind === 'storage.batchRemove') {
    be.admin.createBucket(cfg.bucket);
    const keys = Array.from({ length: cfg.count }, (_, i) => `export-${i + 1}.csv`);
    for (const key of keys) be.admin.putFile(cfg.bucket, key, cfg.bytesEach || 1024);
    return fn(be.insforge, keys);
  }
  if (testCase.kind === 'db.insertArray') {
    be.admin.createTable(cfg.table);
    return fn(be.insforge, cfg.profile);
  }
  if (testCase.kind === 'auth.ownerScope') {
    be.admin.createTable(cfg.table);
    be.admin.createUser({ id: cfg.userId, email: 'judge@example.com', password: 'secret' });
    be.admin.createUser({ id: 'other_user', email: 'other@example.com', password: 'secret' });
    be.admin.seed(cfg.table, [
      { id: `${cfg.table}_1`, user_id: cfg.userId, title: 'mine', body: 'x'.repeat(200), created_at: 2 },
      { id: `${cfg.table}_2`, user_id: 'other_user', title: 'not mine', body: 'x'.repeat(200), created_at: 1 },
    ]);
    be.admin.setCurrentUser(cfg.userId);
    return fn(be.insforge);
  }
  throw new Error(`unknown project repair kind ${testCase.kind}`);
}

function verifyByKind(be, testCase, result) {
  const cfg = testCase.config || {};
  if (testCase.kind === 'db.pagination') {
    if (!result || !Array.isArray(result.items)) return ['missing items array'];
    if (result.total !== cfg.total) return [`total ${result.total} != ${cfg.total}`];
    if (result.items.length !== 10) return [`items length ${result.items.length} != 10`];
    if (result.items[0].id !== `${cfg.table}_${cfg.total - 10}`) return ['wrong page order'];
    const keys = Object.keys(result.items[0]).sort().join(',');
    if (keys !== ['id', cfg.titleCol].sort().join(',')) return [`wrong projected keys ${keys}`];
    return [];
  }
  if (testCase.kind === 'storage.listMeta') {
    return result?.totalBytes === cfg.count * cfg.bytesEach ? [] : ['wrong totalBytes'];
  }
  if (testCase.kind === 'storage.batchRemove') {
    const filesLeft = be.admin.rawFiles(cfg.bucket).length;
    return result?.removed === cfg.count && filesLeft === 0 ? [] : ['wrong removed count or files left behind'];
  }
  if (testCase.kind === 'db.insertArray') {
    const rows = be.admin.rawRows(cfg.table);
    return rows.length === 1 && result?.id === rows[0].id ? [] : ['profile was not inserted'];
  }
  if (testCase.kind === 'auth.ownerScope') {
    if (!Array.isArray(result) || result.length !== 1) return ['did not return only current user rows'];
    if (result[0].id !== `${cfg.table}_1`) return ['wrong owner row'];
    return [];
  }
  return ['unknown verifier'];
}

function summarizeResults(results) {
  return {
    correct: results.filter((r) => r.correct).length,
    efficient: results.filter((r) => r.efficient).length,
    total: results.length,
  };
}

async function runProject(projectDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forger-project-repair-'));
  copyDir(projectDir, tmp);
  const manifest = readJson(path.join(tmp, 'project.repair.json'));
  const before = [];
  for (const testCase of manifest.tests) before.push(await runCase(tmp, testCase));
  const repairs = repairProject(tmp);
  const after = [];
  for (const testCase of manifest.tests) after.push(await runCase(tmp, testCase));
  const beforeByName = new Map(before.map((r) => [r.name, r]));
  const fixedCorrectness = after
    .filter((r) => !beforeByName.get(r.name)?.correct && r.correct)
    .map((r) => r.name);
  const fixedEfficiency = after
    .filter((r) => beforeByName.get(r.name)?.correct && !beforeByName.get(r.name)?.efficient && r.efficient)
    .map((r) => r.name);
  const regressions = after
    .filter((r) => beforeByName.get(r.name)?.correct && !r.correct)
    .map((r) => r.name);

  return {
    name: manifest.name,
    description: manifest.description,
    agentSources: manifest.agentSources || [],
    before: summarizeResults(before),
    after: summarizeResults(after),
    fixedCorrectness,
    fixedEfficiency,
    regressions,
    repairs,
    cases: after.map((r) => ({
      name: r.name,
      kind: r.kind,
      before: {
        correct: beforeByName.get(r.name)?.correct,
        efficient: beforeByName.get(r.name)?.efficient,
      },
      after: {
        correct: r.correct,
        efficient: r.efficient,
        metrics: r.metrics,
      },
    })),
  };
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const fixtureRoot = opts.projects ? path.resolve(opts.projects) : FIXTURES;
  const projectDirs = fs.readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fixtureRoot, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'project.repair.json')));

  const projects = [];
  for (const dir of projectDirs) projects.push(await runProject(dir));
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    claim: 'project-folder repair over agent-written InsForge app files',
    repairEngine: 'optimizer/eval/project_code_repair.js',
    projectCount: projects.length,
    caseCount: projects.reduce((sum, p) => sum + p.after.total, 0),
    before: {
      correct: projects.reduce((sum, p) => sum + p.before.correct, 0),
      efficient: projects.reduce((sum, p) => sum + p.before.efficient, 0),
    },
    after: {
      correct: projects.reduce((sum, p) => sum + p.after.correct, 0),
      efficient: projects.reduce((sum, p) => sum + p.after.efficient, 0),
    },
    fixedCorrectness: projects.flatMap((p) => p.fixedCorrectness.map((name) => `${p.name}:${name}`)),
    fixedEfficiency: projects.flatMap((p) => p.fixedEfficiency.map((name) => `${p.name}:${name}`)),
    regressions: projects.flatMap((p) => p.regressions.map((name) => `${p.name}:${name}`)),
    projects,
  };
  writeJson(opts.out ? path.resolve(opts.out) : OUT, summary);
  console.log(JSON.stringify({
    projects: summary.projectCount,
    cases: summary.caseCount,
    before: summary.before,
    after: summary.after,
    fixedCorrectness: summary.fixedCorrectness.length,
    fixedEfficiency: summary.fixedEfficiency.length,
    regressions: summary.regressions.length,
    out: path.relative(ROOT, opts.out ? path.resolve(opts.out) : OUT),
  }, null, 2));

  if (!summary.projectCount || !summary.caseCount) {
    console.error('ERR no project repair fixtures found');
    process.exit(1);
  }
  if (summary.regressions.length) {
    console.error('ERR project repair caused regressions');
    process.exit(1);
  }
  if (summary.after.correct !== summary.caseCount || summary.after.efficient !== summary.caseCount) {
    console.error('ERR project repair did not make every case correct and efficient');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
