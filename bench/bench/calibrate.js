// forger-bench — calibration. (docs/DESIGN.md §4)
//
// A task is only valid if its own reference solutions discriminate:
//   - oracle  : correct AND scores ~100 (cheapest in the spread)
//   - naive   : correct AND scores < oracle (most expensive)
//   - mids    : correct, between the two
// Prints a per-task table and ALL_TASKS_VALID / a non-zero exit on failure.

'use strict';

const tasks = require('../tasks');
const { gradeSolution } = require('./harness');

async function main() {
  let allOk = true;
  console.log('task                                  oracle  naive   mids            verdict');
  console.log('-'.repeat(86));
  for (const task of tasks.ALL) {
    const o = await gradeSolution(task, task.oracle);
    const nv = await gradeSolution(task, task.naive);
    const mids = [];
    for (const m of task.mid || []) mids.push(await gradeSolution(task, m));

    const oracleOk = o.correct && o.score >= 99.0;     // oracle should be ~optimal
    const naiveOk = nv.correct && nv.score < o.score;  // naive correct but worse
    const midsOk = mids.every((m) => m.correct && m.score <= o.score + 0.001);
    // Inert-axis guard: every WEIGHTED metric must actually vary across the spread,
    // otherwise its weight is handed to every model for free (a silent score inflator).
    const inert = [];
    for (const metric of Object.keys(o.weights || task.weights)) {
      if (o.bounds[metric] && o.bounds[metric].lo === o.bounds[metric].hi) inert.push(metric);
    }
    const inertOk = inert.length === 0;
    const ok = oracleOk && naiveOk && midsOk && inertOk;
    if (!ok) allOk = false;

    const midStr = mids.map((m) => m.score.toFixed(0)).join('/') || '-';
    const verdict = ok ? 'OK'
      : [!oracleOk && 'ORACLE', !naiveOk && 'NAIVE', !midsOk && 'MID',
         !inertOk && `INERT[${inert.join(',')}]`].filter(Boolean).join(',');
    console.log(
      `${task.id.padEnd(36)}  ${o.score.toFixed(1).padStart(5)}  ${nv.score.toFixed(1).padStart(5)}  ${midStr.padEnd(14)}  ${verdict}`,
    );
    if (!ok) {
      if (!o.correct) console.log(`    ! oracle incorrect: ${o.error || 'verify failed'}`);
      if (!nv.correct) console.log(`    ! naive incorrect: ${nv.error || 'verify failed'}`);
    }
  }
  console.log('-'.repeat(86));
  console.log(allOk ? 'ALL_TASKS_VALID' : 'CALIBRATION_FAILED');
  process.exit(allOk ? 0 : 1);
}

main();
