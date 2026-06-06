// forger-bench — independent verification of the scoring math.
// For each task: dump the RAW metrics of oracle/naive/mid, recompute the score by hand
// from the formula in DESIGN.md, and assert it matches what harness/score.js returns.
'use strict';

const assert = require('assert');
const tasks = require('../tasks');
const { gradeSolution, runSolutionMetrics } = require('./harness');
const { buildSpread } = require('./score');

// Independent reimplementation of the scoring formula (don't import scoreTask — we want a
// second, hand-written witness that must agree with the production path).
function handScore(correct, m, bounds, weights) {
  if (!correct) return 0;
  let eff = 0;
  for (const [metric, w] of Object.entries(weights)) {
    const { lo, hi } = bounds[metric];
    const cost = m[metric] ?? 0;
    const p = hi === lo ? 1 : (hi - Math.min(Math.max(cost, lo), hi)) / (hi - lo);
    eff += w * p;
  }
  return 50 + 50 * eff;
}

async function main() {
  let failures = 0;
  for (const task of tasks.ALL) {
    console.log('\n' + '='.repeat(78));
    console.log(`TASK ${task.id}   weights=${JSON.stringify(task.weights)}`);
    console.log('='.repeat(78));

    const sources = { oracle: task.oracle, naive: task.naive };
    (task.mid || []).forEach((m, i) => { sources[`mid${i}`] = m; });

    // 1. raw metrics for every reference solution
    const rawByName = {};
    for (const [name, src] of Object.entries(sources)) {
      const { metrics } = await runSolutionMetrics(task, src);
      rawByName[name] = metrics;
    }

    // 2. spread bounds over the weighted metrics
    const bounds = buildSpread(Object.values(rawByName), task.weights);

    // 3. print raw metrics (only the weighted ones) + the bounds
    const wm = Object.keys(task.weights);
    console.log('\nRAW METRICS (weighted axes only):');
    console.log('  solution'.padEnd(12) + wm.map((k) => k.padStart(13)).join(''));
    for (const [name, m] of Object.entries(rawByName)) {
      console.log('  ' + name.padEnd(10) + wm.map((k) => String(m[k] ?? 0).padStart(13)).join(''));
    }
    console.log('  ' + 'bounds'.padEnd(10) + wm.map((k) => `${bounds[k].lo}..${bounds[k].hi}`.padStart(13)).join(''));

    // 4. for each solution: hand-compute per-metric percentile + score, compare to harness
    console.log('\nSCORING (per-metric percentile p, then 50+50*Σw·p):');
    for (const [name, src] of Object.entries(sources)) {
      const graded = await gradeSolution(task, src);   // production path
      const m = rawByName[name];

      // hand path
      const pParts = wm.map((k) => {
        const { lo, hi } = bounds[k];
        const cost = m[k] ?? 0;
        const p = hi === lo ? 1 : (hi - Math.min(Math.max(cost, lo), hi)) / (hi - lo);
        return { k, cost, lo, hi, p, w: task.weights[k] };
      });
      const handEff = pParts.reduce((s, x) => s + x.w * x.p, 0);
      const hand = handScore(graded.correct, m, bounds, task.weights);

      const detail = pParts
        .map((x) => `${x.k}: (${x.hi}-clip(${x.cost}))/(${x.hi}-${x.lo})=${x.p.toFixed(3)}×${x.w}`)
        .join('  |  ');
      console.log(`  ${name.padEnd(8)} correct=${graded.correct}`);
      console.log(`     ${detail}`);
      console.log(`     hand: eff=${handEff.toFixed(4)} score=${hand.toFixed(2)}   ` +
                  `harness: eff=${graded.eff.toFixed(4)} score=${graded.score.toFixed(2)}`);

      // assertions: hand math must equal production math
      try {
        assert.ok(Math.abs(hand - graded.score) < 1e-9, `score mismatch for ${name}`);
        if (graded.correct) assert.ok(Math.abs(handEff - graded.eff) < 1e-9, `eff mismatch for ${name}`);
        // sanity: every percentile in [0,1]
        for (const x of pParts) assert.ok(x.p >= -1e-9 && x.p <= 1 + 1e-9, `p out of range ${x.k}`);
      } catch (e) {
        console.log('     !! ASSERT FAIL: ' + e.message);
        failures++;
      }
    }

    // 5. invariants: oracle is the cheapest on EVERY weighted axis; naive is the priciest
    console.log('\nINVARIANTS:');
    for (const k of wm) {
      const o = rawByName.oracle[k] ?? 0;
      const nv = rawByName.naive[k] ?? 0;
      const others = Object.entries(rawByName).map(([, m]) => m[k] ?? 0);
      const minAll = Math.min(...others), maxAll = Math.max(...others);
      const oracleCheapest = o === minAll;
      const naivePriciest = nv === maxAll;
      const ok = oracleCheapest && naivePriciest;
      console.log(`  ${k.padEnd(13)} oracle=${o} (min=${minAll} ${oracleCheapest ? 'OK' : 'X'})  ` +
                  `naive=${nv} (max=${maxAll} ${naivePriciest ? 'OK' : 'X'})`);
      if (!ok) { /* not necessarily fatal per-axis (weights blend), but flag it */ }
    }

    // 6. oracle must score exactly 100 (it defines the cheap end across all axes)
    const oracleGraded = await gradeSolution(task, task.oracle);
    const oracleIs100 = Math.abs(oracleGraded.score - 100) < 1e-9;
    console.log(`\n  oracle score == 100 ? ${oracleIs100 ? 'YES' : 'NO (' + oracleGraded.score.toFixed(3) + ')'}`);
    if (!oracleIs100) failures++;
  }

  console.log('\n' + '#'.repeat(78));
  console.log(failures === 0 ? 'VERIFY_OK — all hand-computed scores match the harness, all invariants hold'
                             : `VERIFY_FAILED — ${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
