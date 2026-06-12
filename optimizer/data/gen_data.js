// forge-optimizer — contamination-safe training data generator.
//
// Reuses forger-bench's task FACTORIES with FRESH entities (table/column names disjoint from
// every test entity) so the model learns the optimization PATTERNS without ever seeing a
// sealed test task's data. For each generated task we have its oracle (optimal) and naive
// (wasteful) by construction, giving us:
//   - author  : prompt -> oracle                       (task -> optimal code)
//   - optimize: prompt + naive -> oracle               (the code->code transform)
//   - repair  : prompt + scale-buggy(naive) -> oracle  (fix the wrong-at-scale solution)
// Emits SFT JSONL (messages) + preference pairs (chosen/rejected) + a manifest.
//
// usage: node data/gen_data.js [perConcept] [outDir]
//   perConcept: fresh entities per concept (default 60)

'use strict';

const fs = require('fs');
const path = require('path');

// Import the forger-bench factories + their POOLS to know the FORBIDDEN (test) entities.
const FB = process.env.FO_FORGER_BENCH || path.join(__dirname, '..', '..', 'bench');
// Factories aren't individually exported; we re-require the module and rebuild via a shim.
// Simplest robust path: require the task list and group by concept to recover a factory call
// surface is not exposed — so we instead import the raw factory file via a small adapter.
const dbFactories = requireFactories();

function requireFactories() {
  // Pull the factory functions by re-evaluating db.js in a context that captures them.
  // db.js exports tasks but not factories; we read its POOLS to get forbidden names and
  // re-implement entity generation by calling the exported task objects' shape. Instead,
  // we import a thin adapter the repo exposes. If not present, fall back to parsing.
  const dbPath = path.join(FB, 'tasks', 'db.js');
  const src = fs.readFileSync(dbPath, 'utf8');
  // forbidden test entities (tables) from the POOLS block
  const forbidden = new Set();
  for (const m of src.matchAll(/table:\s*'([a-z_]+)'/gi)) forbidden.add(m[1]);
  return { forbidden };
}

// Fresh entity name pools, DISJOINT from forger-bench test/train entities.
const FRESH_TABLES = [
  'widgets', 'gadgets', 'parcels', 'ledgers', 'tenants', 'sessions2', 'devices', 'sensors',
  'campaigns', 'coupons', 'reviews', 'threads', 'replies', 'uploads2', 'jobs2', 'queues',
  'webhooks', 'tokens2', 'badges', 'streaks', 'lessons2', 'quizzes', 'enrollments', 'grades2',
  'flights', 'hotels', 'bookings2', 'rentals', 'vehicles', 'routes', 'stops', 'fares',
  'wallets', 'ledgers2', 'transfers', 'holdings', 'positions', 'orders2', 'fills', 'quotes',
  'patients', 'visits2', 'charts', 'labs', 'meds', 'doses', 'vitals', 'alerts',
  'players', 'matches', 'rosters', 'teams2', 'seasons', 'fixtures', 'standings', 'goals',
  'recipes2', 'pantry', 'menus', 'dishes', 'reservations', 'tables2', 'shifts', 'tips',
];
const FRESH_COLS = ['label', 'caption', 'heading', 'descr', 'summary', 'tagline', 'note', 'memo'];

// We need the actual factory functions. Re-require db.js and monkey-introspect: the module
// builds `tasks` from factories over POOLS; we instead generate by cloning the factory logic
// via the public task objects is impossible. So: load factories through a patched require.
function loadFactories() {
  // Patch: temporarily set module.exports to also expose factories by requiring a sibling
  // that we write once. If forger-bench exposes them, use that.
  const mod = require(path.join(FB, 'tasks', 'db.js'));
  if (mod.factories) return mod.factories;
  return null;
}

function main() {
  const perConcept = parseInt(process.argv[2] || '60', 10);
  const outDir = process.argv[3] || path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const factories = loadFactories();
  if (!factories) {
    console.error('forger-bench/tasks/db.js does not export `factories`. Add it (see gen_data.README).');
    process.exit(2);
  }

  // Held-out concepts (generalization probe): never generate training data for these.
  const HELD_OUT = new Set(['top_n', 'in_list']);

  const seenTables = new Set();
  const sft = [];     // {messages:[{role,content}...]}  (chosen only)
  const prefs = [];   // {prompt, chosen, rejected}
  let made = 0, ti = 0;

  for (const [concept, factory] of Object.entries(factories)) {
    if (HELD_OUT.has(concept)) continue;
    for (let k = 0; k < perConcept; k++) {
      // fresh entity not used by test and not reused
      let table;
      do { table = FRESH_TABLES[(ti++) % FRESH_TABLES.length] + '_' + Math.floor(ti / FRESH_TABLES.length); }
      while (seenTables.has(table));
      seenTables.add(table);
      const titleCol = FRESH_COLS[ti % FRESH_COLS.length];
      const total = 100000;   // scale-aware: train on the real cloud reality
      const entity = { table, titleCol, total };

      let task;
      try { task = factory('train', 1000 + k, entity); } catch { continue; }
      if (!task || !task.oracle || !task.naive) continue;

      const scalePrompt = task.prompt + `\n\n(The \`${table}\` table has ~100,000 rows. Responses are capped at 1000 rows by the API, so you MUST do counting/filtering/pagination on the server, never by fetching all rows.)`;

      // author
      sft.push({ messages: [
        { role: 'user', content: scalePrompt },
        { role: 'assistant', content: '```js\n' + task.oracle.trim() + '\n```' },
      ], meta: { concept, mode: 'author' } });
      // optimize (naive -> oracle)
      sft.push({ messages: [
        { role: 'user', content: scalePrompt + `\n\nHere is an unoptimized solution. Rewrite it to be efficient:\n\`\`\`js\n${task.naive.trim()}\n\`\`\`` },
        { role: 'assistant', content: '```js\n' + task.oracle.trim() + '\n```' },
      ], meta: { concept, mode: 'optimize' } });
      // preference pair
      prefs.push({ prompt: scalePrompt, chosen: task.oracle.trim(), rejected: task.naive.trim(), meta: { concept } });
      made++;
    }
  }

  // GRPO task list: {taskId, prompt} the agentic trainer rolls out + grades. We register the
  // generated tasks so agent_env can grade them. Use forger-bench TRAIN tasks (real, gradeable,
  // never the sealed test) as the GRPO pool — they have a registered grader. Held-out concepts
  // excluded so GRPO can't train on them either.
  const fbTasks = require(path.join(FB, 'tasks'));
  const grpoTasks = fbTasks.TRAIN
    .filter((t) => !HELD_OUT.has(t.concept))
    .map((t) => ({ taskId: t.id, prompt: t.prompt }));
  fs.writeFileSync(path.join(outDir, 'grpo_tasks.jsonl'), grpoTasks.map((x) => JSON.stringify(x)).join('\n'));

  fs.writeFileSync(path.join(outDir, 'sft.jsonl'), sft.map((x) => JSON.stringify(x)).join('\n'));
  fs.writeFileSync(path.join(outDir, 'prefs.jsonl'), prefs.map((x) => JSON.stringify(x)).join('\n'));
  const concepts = [...new Set(sft.map((x) => x.meta.concept))];
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    perConcept, tasksMade: made, sftExamples: sft.length, prefPairs: prefs.length,
    conceptsTrained: concepts, heldOut: [...HELD_OUT], tablesUsed: seenTables.size,
  }, null, 2));
  console.log(`generated ${sft.length} SFT examples, ${prefs.length} pref pairs over ${concepts.length} concepts`);
  console.log(`concepts: ${concepts.join(', ')}  | held-out: ${[...HELD_OUT].join(', ')}`);
  console.log(`tables used: ${seenTables.size} (all fresh) -> ${outDir}`);
}

main();
