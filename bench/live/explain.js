// forger-bench — real Postgres resource capture via EXPLAIN. (resource-aware scoring)
//
// The request-cost model (mock) counts round-trips and wire bytes — it is BLIND to what
// actually bills a backend under load: seq scans, buffer/disk I/O, CPU time, rows the DB
// physically touched. This module runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the
// live InsForge Postgres (via the CLI's db query) and extracts those true cost signals.
//
// capturePlan(sql) -> {
//   nodeType, seqScans, indexScans, actualTimeMs, sharedHit, sharedRead, tempRead,
//   actualRows, planRows, totalCost, buffers (= hit+read)
// }
//
// Why this matters: a seq scan and an index scan return identical rows in one round-trip
// (request-cost scores them the SAME), but EXPLAIN shows the seq scan touches 19x the
// buffers and runs 8x slower — the difference that decides whether code survives 3 users.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Run a read-only EXPLAIN ANALYZE and return the parsed top plan + recursive aggregates.
// The CLI has no --file flag and shell-arg quoting mangles the parens/quotes in the SQL,
// so we stage the SQL in a temp file and feed it via bash `"$(cat file)"` command
// substitution — the quoting path proven to work for db query in this project.
function capturePlan(sql) {
  const eSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  const tmp = path.join(os.tmpdir(), `fb_explain_${process.pid}_${Math.abs(hash(eSql))}.sql`);
  fs.writeFileSync(tmp, eSql, 'utf8');
  try {
    const r = spawnSync('bash', ['-c', `npx --yes @insforge/cli db query "$(cat '${tmp.replace(/\\/g, '/')}')" --json`], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    const out = r.stdout || '';
    const start = out.indexOf('{');
    if (start === -1) throw new Error('no JSON in db query output: ' + out.slice(0, 200));
    const j = JSON.parse(out.slice(start));
    const plan = j.rows[0]['QUERY PLAN'][0].Plan;
    return summarize(plan);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Walk the plan tree, summing buffers/time and counting scan types.
function summarize(root) {
  let seqScans = 0, indexScans = 0, sharedHit = 0, sharedRead = 0, tempRead = 0, actualRows = 0;
  function walk(node) {
    const nt = node['Node Type'] || '';
    if (nt.includes('Seq Scan')) seqScans++;
    if (nt.includes('Index Scan') || nt.includes('Index Only Scan') || nt.includes('Bitmap')) indexScans++;
    sharedHit += node['Shared Hit Blocks'] || 0;
    sharedRead += node['Shared Read Blocks'] || 0;
    tempRead += node['Temp Read Blocks'] || 0;
    actualRows += node['Actual Rows'] || 0;
    for (const c of node.Plans || []) walk(c);
  }
  walk(root);
  return {
    nodeType: root['Node Type'],
    seqScans, indexScans,
    actualTimeMs: root['Actual Total Time'] || 0,
    totalCost: root['Total Cost'] || 0,
    sharedHit, sharedRead, tempRead,
    buffers: sharedHit + sharedRead,   // total 8KB blocks touched — the core I/O signal
    actualRows,
    planRows: root['Plan Rows'] || 0,
  };
}

module.exports = { capturePlan, summarize };
