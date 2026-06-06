// forge-optimizer — STRONGER data generator (all domains, all concepts).
//
// The first generator only used db factories (4 concepts) -> SFT couldn't help ai/auth/
// vector/storage. This version harvests EVERY forger-bench TRAIN-split task's oracle (the
// correct, efficient solution) as SFT examples, covering all 13 concepts across all 5
// domains. Plus db factories for entity diversity. Held-out concepts excluded.
//
// Contamination: uses ONLY train-split tasks + fresh-entity db variants. Never a test task.
// usage: node data/gen_data2.js [dbVariantsPerConcept] [outDir]

'use strict';
const fs = require('fs');
const path = require('path');
const FB = path.join(__dirname, '..', '..', 'forger-bench');
const fbTasks = require(path.join(FB, 'tasks'));
const dbMod = require(path.join(FB, 'tasks', 'db.js'));

const HELD_OUT = new Set(['top_n', 'in_list']);  // generalization probe
const FRESH = ['widgets','gadgets','parcels','ledgers','tenants','devices','sensors','campaigns','coupons','reviews','threads','replies','badges','streaks','quizzes','enrollments','flights','hotels','rentals','vehicles','routes','wallets','transfers','holdings','positions','fills','quotes','patients','charts','labs','meds','doses','vitals','players','matches','rosters','seasons','fixtures','standings','menus','dishes','shifts','tips','parcels2','crates','bins','racks','aisles','depots'];
const FCOLS = ['label','caption','heading','descr','summary','tagline','note','memo'];

function scaleNote(table) {
  return `\n\n(The \`${table}\` table can have ~100,000 rows. The API caps responses at 1000 rows, so you MUST do counting/filtering/pagination/aggregation on the SERVER — never fetch all rows and process in JS. For counts use select('*', { count: 'exact', head: true }) and read the top-level \`count\` field, NOT \`data\`.)`;
}

function tableOf(task) {
  const m = task.oracle.match(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/i) || task.oracle.match(/rpc\(['"]match_([a-z_]+)['"]/i);
  return m ? m[1] : 'table';
}

function main() {
  const dbVariants = parseInt(process.argv[2] || '40', 10);
  const outDir = process.argv[3] || path.join(__dirname, 'out2');
  fs.mkdirSync(outDir, { recursive: true });
  const sft = [];

  // 1. Every TRAIN-split task (all domains) -> author + optimize SFT examples.
  for (const task of fbTasks.TRAIN) {
    if (HELD_OUT.has(task.concept)) continue;
    const oracle = task.oracle.trim();
    const naive = (task.naive || '').trim();
    const tbl = tableOf(task);
    const prompt = task.prompt + scaleNote(tbl);
    sft.push({ messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '```js\n' + oracle + '\n```' }], meta: { concept: task.concept, mode: 'author', domain: task.domain } });
    if (naive) sft.push({ messages: [
      { role: 'user', content: prompt + `\n\nHere is an inefficient solution — rewrite it to be correct and efficient:\n\`\`\`js\n${naive}\n\`\`\`` },
      { role: 'assistant', content: '```js\n' + oracle + '\n```' }], meta: { concept: task.concept, mode: 'optimize', domain: task.domain } });
  }

  // 2. db factories -> fresh-entity variants (diversity + volume) for the db concepts.
  let ti = 0;
  for (const [concept, factory] of Object.entries(dbMod.factories)) {
    if (HELD_OUT.has(concept)) continue;
    for (let k = 0; k < dbVariants; k++) {
      const table = FRESH[ti % FRESH.length] + '_' + Math.floor(ti / FRESH.length); ti++;
      const titleCol = FCOLS[ti % FCOLS.length];
      let task; try { task = factory('train', 2000 + k, { table, titleCol, total: 100000 }); } catch { continue; }
      if (!task || !task.oracle) continue;
      const prompt = task.prompt + scaleNote(table);
      sft.push({ messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '```js\n' + task.oracle.trim() + '\n```' }], meta: { concept, mode: 'author', domain: 'db' } });
      if (task.naive) sft.push({ messages: [
        { role: 'user', content: prompt + `\n\nHere is an inefficient solution — rewrite it to be correct and efficient:\n\`\`\`js\n${task.naive.trim()}\n\`\`\`` },
        { role: 'assistant', content: '```js\n' + task.oracle.trim() + '\n```' }], meta: { concept, mode: 'optimize', domain: 'db' } });
    }
  }

  fs.writeFileSync(path.join(outDir, 'sft.jsonl'), sft.map((x) => JSON.stringify(x)).join('\n'));
  // grpo tasks: all train-split (non-heldout), all domains
  const grpo = fbTasks.TRAIN.filter((t) => !HELD_OUT.has(t.concept)).map((t) => ({ taskId: t.id, prompt: t.prompt + scaleNote(tableOf(t)) }));
  fs.writeFileSync(path.join(outDir, 'grpo_tasks.jsonl'), grpo.map((x) => JSON.stringify(x)).join('\n'));

  const byConcept = {};
  for (const x of sft) byConcept[x.meta.concept] = (byConcept[x.meta.concept] || 0) + 1;
  const byDomain = {};
  for (const x of sft) byDomain[x.meta.domain] = (byDomain[x.meta.domain] || 0) + 1;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    sftExamples: sft.length, grpoTasks: grpo.length, heldOut: [...HELD_OUT],
    concepts: Object.keys(byConcept), byConcept, byDomain }, null, 2));
  console.log(`STRONG dataset: ${sft.length} SFT examples, ${grpo.length} GRPO tasks`);
  console.log('domains:', JSON.stringify(byDomain));
  console.log('concepts:', Object.keys(byConcept).join(', '));
}
main();
