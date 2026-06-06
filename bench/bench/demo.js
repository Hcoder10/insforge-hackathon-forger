// forger-bench — slice demo. Grades oracle + naive + mid for every task and prints a
// leaderboard-style summary, so you can see the scoring working end to end.
'use strict';

const tasks = require('../tasks');
const { gradeSolution } = require('./harness');
const { aggregate } = require('./score');

async function gradeModel(label, pick) {
  const records = [];
  for (const t of tasks.ALL) records.push(await gradeSolution(t, pick(t)));
  const agg = aggregate(records);
  return { label, agg, records };
}

async function main() {
  // three synthetic "models": one always-oracle, one always-naive, one always-mid(else oracle)
  const models = [
    await gradeModel('oracle-bot', (t) => t.oracle),
    await gradeModel('mid-bot', (t) => (t.mid && t.mid[0]) || t.oracle),
    await gradeModel('naive-bot', (t) => t.naive),
  ];

  console.log('\nPER-TASK (score | eff):');
  console.log('task'.padEnd(34) + models.map((m) => m.label.padStart(14)).join(''));
  for (let i = 0; i < tasks.ALL.length; i++) {
    const row = tasks.ALL[i].id.padEnd(34) + models.map((m) => {
      const r = m.records[i];
      return `${r.score.toFixed(0)}|${(r.eff * 100).toFixed(0)}`.padStart(14);
    }).join('');
    console.log(row);
  }

  console.log('\nLEADERBOARD:');
  console.log('model'.padEnd(14) + 'Pass%'.padStart(8) + 'Score'.padStart(8) + 'Eff%'.padStart(8) + 'Gap'.padStart(8));
  for (const m of [...models].sort((a, b) => b.agg.meanScore - a.agg.meanScore)) {
    const a = m.agg;
    console.log(
      m.label.padEnd(14) +
      a.pass.toFixed(0).padStart(8) +
      a.meanScore.toFixed(1).padStart(8) +
      (a.meanEff * 100).toFixed(0).padStart(8) +
      a.gap.toFixed(1).padStart(8),
    );
  }
  console.log('\n(Gap = Pass - Eff*100 : efficiency left on the table by correct code — the Mercury story)');
}

main().catch((e) => { console.error(e); process.exit(1); });
