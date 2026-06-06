// forger-bench — build a leaderboard from all results/score_*.json.
// Ranks models by meanScore, shows Pass / Score / Eff / Gap + per-domain scores.
// usage: node bench/leaderboard.js
'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, '..', 'results');

function main() {
  const files = fs.existsSync(RESULTS)
    ? fs.readdirSync(RESULTS).filter((f) => f.startsWith('score_') && f.endsWith('.json'))
    : [];
  if (!files.length) { console.log('No results/score_*.json yet. Run a runner + eval_submission first.'); return; }

  const rows = files.map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8'));
    return { model: s.model || f.replace(/^score_|\.json$/g, ''), agg: s.agg, meta: s.meta || {} };
  }).sort((a, b) => b.agg.meanScore - a.agg.meanScore);

  const allDomains = [...new Set(rows.flatMap((r) => Object.keys(r.agg.domains)))].sort();

  console.log('\nFORGER-BENCH LEADERBOARD (sealed test split)\n');
  const head = 'model'.padEnd(22) + 'Pass'.padStart(6) + 'Score'.padStart(7) + 'Eff'.padStart(6) + 'Gap'.padStart(6) + '   ' + allDomains.map((d) => d.slice(0, 7).padStart(8)).join('');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    const a = r.agg;
    let line = r.model.padEnd(22)
      + `${a.pass.toFixed(0)}%`.padStart(6)
      + a.meanScore.toFixed(1).padStart(7)
      + `${(a.meanEff * 100).toFixed(0)}%`.padStart(6)
      + a.gap.toFixed(0).padStart(6) + '   ';
    line += allDomains.map((d) => (a.domains[d] ? a.domains[d].meanScore.toFixed(0) : '-').padStart(8)).join('');
    console.log(line);
  }
  console.log('\nScore = mean 0-100 (50 correct + up to 50 efficiency). Gap = Pass - Eff*100.');

  // write machine-readable leaderboard
  const out = { generated: rows.length, ranking: rows.map((r) => ({ model: r.model, ...r.agg })) };
  fs.writeFileSync(path.join(RESULTS, 'leaderboard.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote results/leaderboard.json (${rows.length} models)`);
}

main();
