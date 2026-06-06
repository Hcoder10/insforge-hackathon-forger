// forger-bench — REALISTIC resource benchmark. (accurate-to-cloud server cost under load)
//
// For each DB task + each model's ACTUAL submitted solution:
//   1. verify the solution is still functionally correct against the LIVE 100k-row table
//   2. snapshot pg_stat_user_tables / pg_statio_user_tables for the task's table
//   3. drive an N-concurrent-user workload of the solution for ~durationMs
//   4. snapshot stats again -> per-request server cost deltas:
//        tuplesPerReq  = seq_tup_read + idx_tup_fetch delta / requests   (rows the DB touched)
//        blocksPerReq  = (heap_blks_read + heap_blks_hit) delta / requests (8KB buffers)
//        seqPerReq     = seq_scan delta / requests                         (seq scans per call)
//   5. also record throughput (rps) and error rate (the capacity "effect")
//
// Why this is accurate-to-cloud and RTT-immune: network round-trip inflates LATENCY equally
// for all solutions, but it does NOT touch what Postgres does on the server. tuples read,
// buffers touched, and seq scans are pure server work — a seq scan over 100k rows costs the
// same server CPU/IO whether the client is 1ms or 80ms away. So we score on those, and
// report throughput separately as the observable effect.
//
// Scoring: Mercury percentile over {tuplesPerReq .5, blocksPerReq .3, seqPerReq .2}, with
// the spread built from the oracle and naive solutions of that task (the optimal vs the
// wasteful), so each model is placed on the real cost continuum.

'use strict';

const fs = require('fs');
const path = require('path');
const { createLiveBackend } = require('./instrument');
const { dbQuery } = require('./dbquery');
const { metricPercentile } = require('../bench/score');

const WEIGHTS = { tuplesPerReq: 0.5, blocksPerReq: 0.3, seqPerReq: 0.2 };

function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('='); env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { baseUrl: env.NEXT_PUBLIC_INSFORGE_URL, anonKey: env.NEXT_PUBLIC_INSFORGE_ANON_KEY };
}

// Read table stats via the SDK DATA PLANE (fb_table_stats RPC), NOT the management API
// (db query). The management API rate-limits hard (429) under a load test; the data plane
// has a far higher limit and is the same path the load itself uses. Pass an `insforge`
// client. (dbQuery/management-API version kept below for one-off use.)
async function tableStatsRPC(insforge, table) {
  const { data, error } = await insforge.database.rpc('fb_table_stats', { tname: table });
  if (error) throw new Error('fb_table_stats: ' + JSON.stringify(error).slice(0, 120));
  const x = data || {};
  const num = (v) => Number(v || 0);
  return { seqScan: num(x.seqScan), seqTup: num(x.seqTup), idxScan: num(x.idxScan), idxTup: num(x.idxTup), blks: num(x.blks) };
}

// Management-API fallback (rate-limited; avoid during load).
function tableStats(table) {
  const sql = `SELECT t.seq_scan, t.seq_tup_read, t.idx_scan, t.idx_tup_fetch, io.heap_blks_read, io.heap_blks_hit FROM pg_stat_user_tables t JOIN pg_statio_user_tables io USING(relid) WHERE t.relname='${table}'`;
  const r = dbQuery(sql);
  const x = r.rows[0] || {};
  const num = (v) => Number(v || 0);
  return { seqScan: num(x.seq_scan), seqTup: num(x.seq_tup_read), idxScan: num(x.idx_scan), idxTup: num(x.idx_tup_fetch), blks: num(x.heap_blks_read) + num(x.heap_blks_hit) };
}

// Run a candidate solution once against the live backend; returns {result, error}.
async function runOnce(insforge, code) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${code}; return solve;`)();
  try { return { result: await fn(insforge), error: null }; }
  catch (e) { return { result: null, error: e }; }
}

// Measure one solution under concurrent load. Returns server-cost-per-request + throughput.
// `verifyScale(result)` (optional) checks correctness against the LIVE 100k-row data — this
// catches solutions that pass the toy-data mock but break at scale (e.g. the PostgREST
// 1000-row cap making a fetch-all paginator return total=1000 instead of 100000).
async function measure(creds, table, code, { concurrency = 8, durationMs = 4000, verifyScale = null } = {}) {
  const { insforge } = await createLiveBackend(creds);
  // correctness probe — against REAL scaled data, not the mock. Retry a few times so a
  // transient 429/partial under load doesn't misreport a correct solution as failing.
  let probe = { error: new Error('init'), result: null };
  for (let a = 0; a < 4; a++) {
    probe = await runOnce(insforge, code);
    if (!probe.error && probe.result != null) break;
    await new Promise((r) => setTimeout(r, 800 * (a + 1)));
  }
  const ran = !probe.error && probe.result != null;
  const correct = ran && (verifyScale ? !!safeVerify(verifyScale, probe.result) : true);
  const scaleBug = ran && verifyScale ? !safeVerify(verifyScale, probe.result) : false;

  const before = await tableStatsRPC(insforge, table);
  let count = 0, errors = 0;
  const deadline = Date.now() + durationMs;
  const t0 = Date.now();
  async function worker() {
    const { insforge: cli } = await createLiveBackend(creds);
    while (Date.now() < deadline) {
      const r = await runOnce(cli, code);
      if (r.error) errors++; else count++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = (Date.now() - t0) / 1000;
  const after = await tableStatsRPC(insforge, table);

  const reqs = Math.max(count, 1);
  const tuples = (after.seqTup - before.seqTup) + (after.idxTup - before.idxTup);
  const blocks = after.blks - before.blks;
  const seqs = after.seqScan - before.seqScan;
  return {
    correct, scaleBug, count, errors, rps: +(count / elapsed).toFixed(1),
    tuplesPerReq: Math.round(tuples / reqs),
    blocksPerReq: Math.round(blocks / reqs),
    seqPerReq: +(seqs / reqs).toFixed(3),
  };
}

function safeVerify(fn, result) { try { return fn(result); } catch { return false; } }

module.exports = { measure, tableStats, tableStatsRPC, WEIGHTS, loadEnv, metricPercentile };
