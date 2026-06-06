// forger-bench — resource-aware scoring. (the honest efficiency model)
//
// The request-cost model (mock) is blind to server work: a seq scan and an index scan are
// 1 round-trip each, identical wire bytes — it scores them the same. This model instead
// scores on what Postgres ACTUALLY did, captured via EXPLAIN (ANALYZE, BUFFERS) on the live
// backend at SCALE (100k+ rows), where the difference is real:
//
//   buffers     — 8KB blocks touched (the core I/O cost; seq scan touches ~all of them)
//   actualTimeMs— real execution time, server-side (no network noise)
//   seqScans    — count of sequential scans (the cardinal sin at scale)
//
// Same Mercury percentile idea as request-cost, but the spread is built from the REAL plans
// of oracle vs naive at scale, and the axes are server resources, not request counts.
//
// Empirically validated: on scale_test (100k rows), filtering an unindexed column ran
// Seq Scan 11.6ms / 1914 buffers; with an index, Bitmap scan 1.5ms / 102 buffers — a 19x
// I/O difference the request-cost model reports as identical.

'use strict';

const { metricPercentile } = require('../bench/score');

// Resource cost axes and their weights. buffers dominates (it's what scales), then time,
// then an explicit seq-scan penalty so "correct but seq-scans 1M rows" is punished hard.
const RESOURCE_WEIGHTS = { buffers: 0.5, actualTimeMs: 0.3, seqScans: 0.2 };

// Build per-axis [lo,hi] bounds from a set of EXPLAIN summaries (oracle/naive/...).
function buildResourceSpread(summaries) {
  const bounds = {};
  for (const axis of Object.keys(RESOURCE_WEIGHTS)) {
    let lo = Infinity, hi = -Infinity;
    for (const s of summaries) { const v = s[axis] ?? 0; if (v < lo) lo = v; if (v > hi) hi = v; }
    bounds[axis] = { lo, hi };
  }
  return bounds;
}

// Resource efficiency in [0,1] for one candidate summary vs the spread.
function resourceEfficiency(summary, bounds) {
  let eff = 0; const per = {};
  for (const [axis, w] of Object.entries(RESOURCE_WEIGHTS)) {
    const { lo, hi } = bounds[axis];
    const p = metricPercentile(summary[axis] ?? 0, lo, hi);
    per[axis] = p; eff += w * p;
  }
  return { eff, per };
}

// Full resource score: 0 if incorrect, else 50 + 50*resourceEfficiency.
function resourceScore({ correct, summary, bounds }) {
  if (!correct) return { score: 0, eff: 0, per: {} };
  const { eff, per } = resourceEfficiency(summary, bounds);
  return { score: 50 + 50 * eff, eff, per };
}

module.exports = { RESOURCE_WEIGHTS, buildResourceSpread, resourceEfficiency, resourceScore };
