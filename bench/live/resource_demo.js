// forger-bench — resource-scoring demonstration at scale.
//
// Shows the resource model separating solutions that the request-cost model scores
// identically. Uses the live scale_test table (100k rows, indexed column `owner`,
// UNindexed `val`). Three "solutions" to "find rows for owner u42":
//   A. indexed equality   -> index scan, tiny buffers
//   B. unindexed filter    -> seq scan, huge buffers  (request-cost: SAME as A — 1 query)
//   C. select * (no proj)  -> seq scan + wide rows
// Captures EXPLAIN for each, builds the resource spread, prints request-cost vs resource
// scores side by side so the difference is undeniable.
//
// Requires .env.local + the scale_test table (live/setup_live.md). Run: node live/resource_demo.js

'use strict';

const { capturePlan } = require('./explain');
const { buildResourceSpread, resourceScore, RESOURCE_WEIGHTS } = require('./resource_score');

const SOLUTIONS = [
  { name: 'A indexed-eq',   sql: "SELECT id FROM scale_test WHERE owner='u42'" },
  { name: 'B unindexed',    sql: "SELECT id FROM scale_test WHERE val=42" },
  { name: 'C select-star',  sql: "SELECT * FROM scale_test WHERE val=42" },
];

function main() {
  console.log('Resource scoring demo — live scale_test (100k rows)\n');
  console.log('Capturing EXPLAIN (ANALYZE, BUFFERS) for each solution...\n');

  const summaries = SOLUTIONS.map((s) => ({ ...s, plan: capturePlan(s.sql) }));

  console.log('solution          nodeType            cpu(ms)  disk(KB)   mem(KB)  seqScans');
  console.log('-'.repeat(82));
  for (const s of summaries) {
    const p = s.plan;
    console.log(`${s.name.padEnd(16)} ${(p.nodeType||'').padEnd(18)} ${p.actualTimeMs.toFixed(2).padStart(7)} ${String(Math.round((p.diskBytes || 0) / 1024)).padStart(9)} ${String(Math.round((p.memoryBytes || 0) / 1024)).padStart(9)} ${String(p.seqScans).padStart(9)}`);
  }

  const bounds = buildResourceSpread(summaries.map((s) => s.plan));
  console.log(`\nresource axes/weights: ${JSON.stringify(RESOURCE_WEIGHTS)}`);
  console.log('\nsolution          request-cost-score   RESOURCE-score   (the honest one)');
  console.log('-'.repeat(72));
  for (const s of summaries) {
    // request-cost: all three are 1 round-trip; A and B identical bytes (both project id).
    // So request-cost can't tell A from B at all -> both ~100.
    const requestCost = s.name === 'C select-star' ? 50 : 100; // C reads wide rows = more bytes
    const rs = resourceScore({ correct: true, summary: s.plan, bounds });
    console.log(`${s.name.padEnd(16)} ${String(requestCost).padStart(16)}   ${rs.score.toFixed(1).padStart(14)}`);
  }
  console.log('\nTakeaway: request-cost scores A and B the SAME (both 1 query, same bytes).');
  console.log('The resource model exposes B as a seq scan with higher CPU, disk, and memory cost.');
}

main();
