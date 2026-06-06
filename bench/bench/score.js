// forger-bench — scoring (docs/DESIGN.md §3).
//
// Mercury-style "Beyond": score the candidate's per-metric cost as a PERCENTILE against a
// per-task solution spread (oracle .. naive .. mids), not as an absolute. Then blend the
// per-metric percentiles by the task's category weights into a 0..100 task score.

'use strict';

// Per-metric percentile p_m in [0,1]: 1.0 = matched the cheapest, 0.0 = as bad as priciest.
function metricPercentile(cost, lo, hi) {
  if (hi === lo) return 1.0;                 // metric doesn't vary across the spread -> free
  const clip = Math.min(Math.max(cost, lo), hi);
  return (hi - clip) / (hi - lo);
}

// spread: array of metrics objects from running oracle/naive/mid through the mock.
// Returns { metric: {lo, hi}, ... } over the weighted metrics only.
function buildSpread(spreadMetricsList, weights) {
  const bounds = {};
  for (const metric of Object.keys(weights)) {
    let lo = Infinity, hi = -Infinity;
    for (const m of spreadMetricsList) {
      const v = m[metric] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    bounds[metric] = { lo, hi };
  }
  return bounds;
}

// efficiency in [0,1] = Σ w_m * p_m  for a candidate's metrics against the spread bounds.
function efficiency(candidateMetrics, bounds, weights) {
  let eff = 0;
  const perMetric = {};
  for (const [metric, w] of Object.entries(weights)) {
    const { lo, hi } = bounds[metric];
    const p = metricPercentile(candidateMetrics[metric] ?? 0, lo, hi);
    perMetric[metric] = p;
    eff += w * p;
  }
  return { eff, perMetric };
}

// Full task score: 0 if incorrect, else 50 + 50*efficiency.
function scoreTask({ correct, candidateMetrics, bounds, weights }) {
  if (!correct) return { score: 0, eff: 0, perMetric: {} };
  const { eff, perMetric } = efficiency(candidateMetrics, bounds, weights);
  return { score: 50 + 50 * eff, eff, perMetric };
}

// Aggregate a list of per-task records into leaderboard headline numbers (§3).
function aggregate(records) {
  const n = records.length || 1;
  const passed = records.filter((r) => r.correct);
  const pass = (passed.length / n) * 100;
  const meanScore = records.reduce((s, r) => s + r.score, 0) / n;
  // meanEff: efficiency among CORRECT solutions only (how efficient the model is WHEN it works).
  const meanEff = passed.length ? passed.reduce((s, r) => s + r.eff, 0) / passed.length : 0;
  // meanEffAll: efficiency over ALL tasks (failed -> 0), the Mercury-faithful basis for Gap.
  const meanEffAll = records.reduce((s, r) => s + (r.correct ? r.eff : 0), 0) / n;
  // Gap = correctness% - achieved-efficiency% over all tasks. Always >=0: the headroom
  // between "passes the test" and "passes efficiently". This is the headline Mercury number.
  const gap = pass - meanEffAll * 100;
  // per-domain breakdown
  const byDomain = {};
  for (const r of records) {
    const d = r.domain || 'unknown';
    (byDomain[d] = byDomain[d] || []).push(r);
  }
  const domains = {};
  for (const [d, rs] of Object.entries(byDomain)) {
    const p = rs.filter((r) => r.correct);
    domains[d] = {
      n: rs.length,
      pass: (p.length / rs.length) * 100,
      meanScore: rs.reduce((s, r) => s + r.score, 0) / rs.length,
      meanEff: p.length ? p.reduce((s, r) => s + r.eff, 0) / p.length : 0,
    };
  }
  return { n: records.length, pass, meanScore, meanEff, meanEffAll, gap, domains };
}

module.exports = { metricPercentile, buildSpread, efficiency, scoreTask, aggregate };
