// forger-bench — run the realistic resource benchmark for all models. (the honest leaderboard)
//
// For every model submission and every DB test task, run the model's ACTUAL code against the
// live 100k-row table under N-concurrent-user load, measure RTT-immune server cost per
// request (tuples read, buffers touched, seq scans), and score on the Mercury percentile of
// that cost — with the spread anchored by the task's own oracle (efficient) and naive
// (wasteful) measured the same way. Correctness is re-checked AT SCALE, so solutions that
// pass the toy mock but break on real data (PostgREST 1000-row cap) score 0.
//
// usage: node live/run_resource_bench.js [concurrency] [durationMs]
//   reads results/sub_*.json, writes results/resource_<model>.json + resource_leaderboard.json

'use strict';

const fs = require('fs');
const path = require('path');
const tasks = require('../tasks');
const { measure, loadEnv, WEIGHTS, metricPercentile } = require('./resource_bench');
const { verifierFor } = require('./scale_verify');

const RESULTS = path.join(__dirname, '..', 'results');
const manifest = require('./scale_manifest.json');
const tableFor = Object.fromEntries(manifest.map((m) => [m.id, m.table]));

function scoreFromCost(cost, bounds) {
  if (!cost.correct) return { score: 0, eff: 0 };
  let eff = 0;
  for (const [axis, w] of Object.entries(WEIGHTS)) {
    const { lo, hi } = bounds[axis];
    eff += w * metricPercentile(cost[axis] ?? 0, lo, hi);
  }
  return { score: 50 + 50 * eff, eff };
}

async function main() {
  const creds = loadEnv();
  const concurrency = parseInt(process.argv[2] || '6', 10);
  const durationMs = parseInt(process.argv[3] || '4000', 10);
  // Concepts that translate to scale. EXCLUDED: column_projection & filter_pushdown ask to
  // "return ALL matching rows" — but PostgREST caps every response at 1000 rows, so even the
  // correct oracle can't return 100k. At scale the right answer is to paginate, which those
  // task specs don't allow; they're a toy-data artifact. (Documented in live/RESOURCE.md.)
  const SCALE_CONCEPTS = new Set(['pagination', 'count_only', 'top_n', 'in_list']);
  const dbTasks = tasks.TEST.filter((t) => t.domain === 'db' && tableFor[t.id] && SCALE_CONCEPTS.has(t.concept));

  // discover model submissions
  const subs = fs.readdirSync(RESULTS).filter((f) => f.startsWith('sub_') && f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')));
  console.log(`Resource benchmark: ${subs.length} models x ${dbTasks.length} DB tasks @ ${concurrency} users x ${durationMs}ms\n`);

  // 1. Build per-task cost spread from oracle + naive (measured live, same as candidates).
  const spreads = {};
  for (const task of dbTasks) {
    const table = tableFor[task.id];
    const vf = verifierFor(task.concept);
    const o = await measure(creds, table, task.oracle, { concurrency, durationMs, verifyScale: vf });
    const n = await measure(creds, table, task.naive, { concurrency, durationMs, verifyScale: vf });
    const bounds = {};
    for (const axis of Object.keys(WEIGHTS)) {
      const vals = [o[axis], n[axis]];
      bounds[axis] = { lo: Math.min(...vals), hi: Math.max(...vals) };
    }
    spreads[task.id] = { bounds, oracle: o, naive: n };
    console.log(`spread ${task.id.padEnd(26)} oracle{tpr:${o.tuplesPerReq},rps:${o.rps},ok:${o.correct}} naive{tpr:${n.tuplesPerReq},rps:${n.rps},ok:${n.correct}${n.scaleBug?',SCALEBUG':''}}`);
  }

  // 2. Score each model's real code per task.
  const results = {};
  for (const sub of subs) {
    const recs = [];
    for (const task of dbTasks) {
      const code = sub.solutions[task.id];
      const table = tableFor[task.id];
      const vf = verifierFor(task.concept);
      if (!code) { recs.push({ id: task.id, correct: false, score: 0, scaleBug: false, note: 'no-solution' }); continue; }
      const cost = await measure(creds, table, code, { concurrency, durationMs, verifyScale: vf });
      const { score, eff } = scoreFromCost(cost, spreads[task.id].bounds);
      recs.push({ id: task.id, ...cost, score, eff });
    }
    const correct = recs.filter((r) => r.correct);
    const scaleBugs = recs.filter((r) => r.scaleBug);
    const agg = {
      n: recs.length,
      pass: (correct.length / recs.length) * 100,
      meanScore: recs.reduce((s, r) => s + r.score, 0) / recs.length,
      meanRps: correct.length ? +(correct.reduce((s, r) => s + (r.rps || 0), 0) / correct.length).toFixed(1) : 0,
      scaleBugs: scaleBugs.length,
    };
    results[sub.model] = { model: sub.model, agg, records: recs };
    fs.writeFileSync(path.join(RESULTS, `resource_${sub.model.replace(/[:/]/g, '-')}.json`), JSON.stringify(results[sub.model], null, 2));
    console.log(`\n${sub.model}: pass=${agg.pass.toFixed(0)}% score=${agg.meanScore.toFixed(1)} rps=${agg.meanRps} scaleBugs=${agg.scaleBugs}`);
  }

  // 3. Leaderboard
  const ranking = Object.values(results).map((r) => ({ model: r.model, ...r.agg })).sort((a, b) => b.meanScore - a.meanScore);
  fs.writeFileSync(path.join(RESULTS, 'resource_leaderboard.json'), JSON.stringify({ concurrency, durationMs, ranking }, null, 2));
  console.log('\n\nRESOURCE LEADERBOARD (server cost under load, 100k rows, RTT-immune)\n');
  console.log('model'.padEnd(22) + 'Pass'.padStart(6) + 'Score'.padStart(7) + 'RPS'.padStart(7) + 'ScaleBugs'.padStart(11));
  console.log('-'.repeat(53));
  for (const r of ranking) {
    console.log(r.model.padEnd(22) + `${r.pass.toFixed(0)}%`.padStart(6) + r.meanScore.toFixed(1).padStart(7) + String(r.meanRps).padStart(7) + String(r.scaleBugs).padStart(11));
  }
  console.log('\nScore = server-cost percentile under load. ScaleBugs = solutions that pass toy');
  console.log('data but return WRONG results at 100k rows (e.g. PostgREST 1000-row cap).');
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
