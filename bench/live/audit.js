// forger-bench — LIVE AUDIT. (docs/DESIGN.md §6, M4)
//
// Validates that the hermetic mock's PREDICTED costs agree with a REAL InsForge backend.
// For each auditable task, runs its oracle + naive against:
//   (a) the mock         -> predicted metrics
//   (b) the live backend -> measured metrics (HTTP-instrumented)
// then checks the AUDIT INVARIANT that matters for the benchmark's validity:
//   on every weighted axis, the mock and live must AGREE ON THE RANKING (oracle <= naive),
//   i.e. the mock never says "A is cheaper than B" when live says the opposite.
//
// Absolute counts differ (the mock approximates byte sizes; PostgREST adds headers, etc.)
// — that's expected and fine. What must hold is the *ordering*, because the score is a
// percentile WITHIN a per-task spread, not an absolute.
//
// Requires .env.local with NEXT_PUBLIC_INSFORGE_URL / _ANON_KEY and the live tables seeded
// (see live/setup_live.md). Run: node live/audit.js

'use strict';

const fs = require('fs');
const path = require('path');
const { createBackend } = require('../mock');
const { createLiveBackend } = require('./instrument');
const { compile } = require('../tasks/db');
const auditTasks = require('./audit_tasks');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return null;
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    baseUrl: env.NEXT_PUBLIC_INSFORGE_URL || env.INSFORGE_URL,
    anonKey: env.NEXT_PUBLIC_INSFORGE_ANON_KEY || env.INSFORGE_ANON_KEY,
  };
}

async function runMock(task, code) {
  const be = createBackend();
  task.setupMock(be);
  if (task.globals) for (const [k, v] of Object.entries(task.globals(be))) global[k] = v;
  try {
    const fn = compile(code);
    const result = await fn(be.insforge);
    return { metrics: be.metrics, result };
  } finally {
    if (task.globals) for (const k of Object.keys(task.globals(be))) delete global[k];
  }
}

async function runLive(task, code, creds) {
  const { insforge, metrics } = await createLiveBackend(creds);
  if (task.liveGlobals) for (const [k, v] of Object.entries(task.liveGlobals())) global[k] = v;
  try {
    const fn = compile(code);
    const result = await fn(insforge);
    return { metrics, result };
  } finally {
    if (task.liveGlobals) for (const k of Object.keys(task.liveGlobals())) delete global[k];
  }
}

async function main() {
  const creds = loadEnv();
  if (!creds || !creds.baseUrl || !creds.anonKey) {
    console.log('SKIP: no .env.local with NEXT_PUBLIC_INSFORGE_URL / _ANON_KEY — live audit skipped.');
    console.log('(Live mode is ready; provide credentials + seed tables to run the real audit.)');
    process.exit(0);
  }
  console.log(`Live backend: ${creds.baseUrl}\n`);

  let disagreements = 0;
  for (const task of auditTasks) {
    console.log('='.repeat(80));
    console.log(`AUDIT ${task.id}   weighted axes: ${task.axes.join(', ')}`);
    console.log('='.repeat(80));

    const mockO = await runMock(task, task.oracle);
    const mockN = await runMock(task, task.naive);
    const liveO = await runLive(task, task.oracleLive || task.oracle, creds);
    const liveN = await runLive(task, task.naiveLive || task.naive, creds);

    // correctness on live (sanity: did the candidate actually return the right thing?)
    const liveOok = task.verifyLive ? task.verifyLive(liveO.result) : true;
    const liveNok = task.verifyLive ? task.verifyLive(liveN.result) : true;
    console.log(`live correctness: oracle=${liveOok}  naive=${liveNok}`);

    console.log('\naxis           mock(oracle/naive)     live(oracle/naive)     ranking');
    console.log('-'.repeat(80));
    for (const axis of task.axes) {
      const mo = mockO.metrics[axis] ?? 0, mn = mockN.metrics[axis] ?? 0;
      const lo = liveO.metrics[axis] ?? 0, ln = liveN.metrics[axis] ?? 0;
      // ranking must agree: sign(oracle-naive) compatible (mock says oracle<=naive => live too)
      const mockSays = mo < mn ? '<' : mo > mn ? '>' : '=';
      const liveSays = lo < ln ? '<' : lo > ln ? '>' : '=';
      // disagreement = mock claims a strict ordering that live reverses
      const conflict = (mockSays === '<' && liveSays === '>') || (mockSays === '>' && liveSays === '<');
      if (conflict) disagreements++;
      console.log(
        `${axis.padEnd(14)} ${`${mo}/${mn}`.padEnd(22)} ${`${lo}/${ln}`.padEnd(22)} ` +
        `mock ${mockSays}  live ${liveSays}  ${conflict ? 'CONFLICT' : 'ok'}`,
      );
    }
    console.log('');
  }

  console.log('#'.repeat(80));
  console.log(disagreements === 0
    ? 'AUDIT_OK — mock cost rankings agree with the live backend on every weighted axis'
    : `AUDIT_FAILED — ${disagreements} axis ranking conflict(s) mock vs live`);
  process.exit(disagreements === 0 ? 0 : 1);
}

main().catch((e) => { console.error('AUDIT_ERROR', e); process.exit(1); });
