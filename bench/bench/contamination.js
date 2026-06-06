// forger-bench — contamination control check. (docs/DESIGN.md §7)
//
// Guarantees the benchmark's integrity: the ENTITY NAMES (table/bucket names) used in any
// sealed `test` task must NEVER appear in any `train` task. A model trained on the train
// split must not have seen a test task's entities. Also checks test ids are unique and that
// every concept has both a train instance and >=1 test instance.
'use strict';

const tasks = require('../tasks');

// Pull entity tokens (table/bucket names) out of a task by scanning its oracle source for
// .from('X') and bucket-ish identifiers, plus the prompt. Conservative: extracts quoted
// identifiers passed to from()/createTable-like calls.
function entitiesOf(task) {
  const names = new Set();
  const src = `${task.oracle}\n${task.naive}\n${(task.mid || []).join('\n')}\n${task.prompt}`;
  for (const m of src.matchAll(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/gi)) names.add(m[1]);
  // rpc target table, only inside an rpc('match_X', ...) call (not the match_count arg)
  for (const m of src.matchAll(/rpc\(['"]match_([a-z_][a-z0-9_]*)['"]/gi)) names.add(m[1]);
  return names;
}

function main() {
  let problems = 0;

  // 1. collect train entities and test entities
  const trainEntities = new Set();
  for (const t of tasks.TRAIN) for (const e of entitiesOf(t)) trainEntities.add(e);

  const testEntities = new Map(); // entity -> [taskIds]
  for (const t of tasks.TEST) {
    for (const e of entitiesOf(t)) {
      if (!testEntities.has(e)) testEntities.set(e, []);
      testEntities.get(e).push(t.id);
    }
  }

  // 2. overlap = contamination
  console.log('CONTAMINATION CHECK');
  console.log('-'.repeat(60));
  const overlap = [...testEntities.keys()].filter((e) => trainEntities.has(e));
  if (overlap.length) {
    problems += overlap.length;
    for (const e of overlap) console.log(`  LEAK: entity '${e}' appears in BOTH train and test (${testEntities.get(e).join(', ')})`);
  } else {
    console.log(`  OK: ${testEntities.size} test entities, ${trainEntities.size} train entities, zero overlap`);
  }

  // 3. unique test ids
  const ids = tasks.TEST.map((t) => t.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) { problems += dup.length; console.log(`  DUP test ids: ${[...new Set(dup)].join(', ')}`); }
  else console.log(`  OK: ${ids.length} test ids all unique`);

  // 4. every concept has train + >=1 test
  const concepts = {};
  for (const t of tasks.ALL) {
    concepts[t.concept] = concepts[t.concept] || { train: 0, test: 0 };
    concepts[t.concept][t.split] += 1;
  }
  console.log('\nPER-CONCEPT (train/test):');
  for (const [c, v] of Object.entries(concepts)) {
    const ok = v.train >= 1 && v.test >= 1;
    if (!ok) problems++;
    console.log(`  ${c.padEnd(20)} ${v.train}/${v.test}  ${ok ? '' : '<-- needs train+test'}`);
  }

  console.log('\n' + '#'.repeat(60));
  console.log(problems === 0 ? 'CONTAMINATION_OK — sealed test split is clean' : `CONTAMINATION_FAILED — ${problems} problem(s)`);
  process.exit(problems === 0 ? 0 : 1);
}

main();
