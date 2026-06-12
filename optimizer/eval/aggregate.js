// forge-optimizer — aggregate ablation results into a leaderboard table.
// Reads forger-bench results/score_fo-*.json (each a graded forge-optimizer variant) plus the
// frontier baselines, and prints the ablation comparison + writes docs/ABLATIONS_RESULTS.md.
'use strict';

const fs = require('fs');
const path = require('path');
const FB = process.env.FO_FORGER_BENCH || path.join(__dirname, '..', '..', 'bench');
const RESULTS = path.join(FB, 'results');

const ABLATION_LABELS = {
  'fo-base': 'A0 base Qwen3.6-35B-A3B',
  'fo-sft': 'A2 SFT (4-concept)',
  'fo-sft2': 'A2b SFT (all-domain)',
  'fo-sft-author': 'A1 SFT (author only)',
  'fo-rft': 'A2.5 +RFT',
  'fo-grpo': 'A3 +agentic GRPO',
  'fo-grpo2': 'A3b GRPO (on all-domain SFT)',
};

function load(file) {
  try { return JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')); } catch { return null; }
}

function row(name, s) {
  if (!s || !s.agg) return null;
  const a = s.agg;
  // held-out concept score (top_n + in_list) — the generalization probe
  const ho = (s.records || []).filter((r) => /\.(top_n|in_list)\./.test(r.id));
  const hoScore = ho.length ? (ho.reduce((x, r) => x + r.score, 0) / ho.length) : null;
  return {
    name, pass: a.pass, score: a.meanScore,
    held: hoScore, model: s.model,
  };
}

function main() {
  const files = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS) : [];
  const foScores = files.filter((f) => /^score_fo-/.test(f));
  const baseline = ['score_codex.json', 'score_claude.json', 'score_qwen3.6.json']
    .map((f) => { const s = load(f); return s ? row(s.model, s) : null; }).filter(Boolean);

  const rows = foScores.map((f) => {
    const tag = f.replace(/^score_|\.json$/g, '');
    const s = load(f);
    return row(ABLATION_LABELS[tag] || tag, s);
  }).filter(Boolean);

  const all = [...rows].sort((a, b) => b.score - a.score);

  let md = '# forge-optimizer — Ablation Results (auto-generated)\n\n';
  md += '| Variant | Pass% | Score | Held-out (top_n,in_list) |\n|---|---|---|---|\n';
  for (const r of all) {
    md += `| ${r.name} | ${r.pass.toFixed(1)} | ${r.score.toFixed(1)} | ${r.held != null ? r.held.toFixed(1) : 'n/a'} |\n`;
  }
  md += '\n## Frontier baselines (request-cost, sealed test)\n\n| Model | Pass% | Score |\n|---|---|---|\n';
  for (const b of baseline) md += `| ${b.model} | ${b.pass.toFixed(1)} | ${b.score.toFixed(1)} |\n`;
  md += '\nHeld-out = mean score on top_n + in_list (concepts NEVER trained on) — measures whether\n';
  md += 'the model learned optimization vs concept templates.\n';

  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'ABLATIONS_RESULTS.md'), md);
  console.log(md);
  console.log(`\n(${rows.length} forge-optimizer variants, ${baseline.length} baselines)`);
}

main();
