// forger-bench — scale-aware correctness verifiers for the live resource benchmark.
//
// The mock task.verify assumes small N (e.g. total===57). At 100k rows the CORRECT answer
// differs, and — crucially — some solutions that pass the mock break at scale (the PostgREST
// 1000-row cap makes a fetch-all paginator report total=1000 instead of 100000). These
// verifiers check correctness against the real 100k-row live data, keyed by concept.

'use strict';

const N = 100000;

// Each verifier takes the solution's result and returns true iff correct at scale (N rows,
// created_at = 1..N, so newest = N).
const VERIFIERS = {
  // page 2 (size 10) newest-first + true total. Naive fetch-all returns total=1000 -> fails.
  pagination: (r) => r && Array.isArray(r.items) && r.items.length === 10 && r.total === N,
  // all rows, projected to {id, <titleCol>}. At scale select('*') caps at 1000 -> length<N fails.
  column_projection: (r) => Array.isArray(r) && r.length === N,
  // ids where created_at > N/2  (created_at is 1..N). Naive fetch-all (cap 1000) -> wrong count.
  filter_pushdown: (r) => Array.isArray(r) && r.length === N - Math.floor(N / 2),
  // just the total count. Naive .length on capped fetch -> 1000, wrong.
  count_only: (r) => r && r.total === N,
  // top 5 by created_at desc. created_at = 1..N, and the seeder sets id = '<table>_'||g, so
  // the true top-5 ids end in N, N-1, ... A naive sort of the capped 1000-row fetch returns
  // ids ending in 1000,999,... -> the first id won't end in N, so it's caught as wrong.
  top_n: (r) => Array.isArray(r) && r.length === 5 && typeof r[0] === 'string' && r[0].endsWith('_' + N),
  // fetch a fixed set of ids -> small result, unaffected by cap; correct if it returns them.
  in_list: (r) => Array.isArray(r) && r.length > 0,
};

function verifierFor(concept) { return VERIFIERS[concept] || null; }

module.exports = { verifierFor, N };
