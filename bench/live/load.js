// forger-bench — concurrent-load harness. (resource-aware scoring: the "dies at N users" axis)
//
// Request-cost and even EXPLAIN are single-shot. The failure the user cares about — "works
// in dev, falls over at 3 concurrent users" — only shows under concurrency: lock waits,
// connection-pool saturation, and the super-linear cost of a seq scan when 50 of them run
// at once. This harness fires a solution's representative query at N concurrent workers
// against the live backend and measures the latency distribution + throughput.
//
// loadTest(makeRequest, { concurrency, durationMs }) -> { count, errors, p50, p95, p99, rps }
//   makeRequest: async () => void   (one unit of the workload; e.g. the SDK call the
//                                    candidate's pattern produces, against the 100k-row table)

'use strict';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function loadTest(makeRequest, { concurrency = 3, durationMs = 4000 } = {}) {
  const latencies = [];
  let errors = 0, count = 0;
  const deadline = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try { await makeRequest(); latencies.push(Date.now() - t0); count++; }
      catch { errors++; }
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = (Date.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  return {
    concurrency, count, errors,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: +(count / elapsed).toFixed(1),
  };
}

// Sweep several concurrency levels to expose the scaling curve (3, 10, 50 users).
async function loadSweep(makeRequest, levels = [1, 3, 10], durationMs = 3000) {
  const out = [];
  for (const c of levels) out.push(await loadTest(makeRequest, { concurrency: c, durationMs }));
  return out;
}

module.exports = { loadTest, loadSweep, percentile };
