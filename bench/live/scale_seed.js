// forger-bench — seed live tables at scale for the resource benchmark.
//
// The mock already defines each task's schema (via task.setup). We run setup against a mock
// backend, read the resulting table's columns, then mirror that table to the LIVE Postgres
// at SCALE (default 100k rows) so model solutions can run against real data under load.
//
// Only DB-family tasks that actually hit Postgres are seeded (db.*, auth.*, vector.similarity).
// Storage/ai tasks don't touch the DB and are excluded from resource scoring.
//
// usage: node live/scale_seed.js [rows]   (default 100000)

'use strict';

const { createBackend } = require('../mock');
const { dbQuery } = require('./dbquery');
const tasks = require('../tasks');

// Resource-relevant tasks: the DB domain. These solutions run directly against a scaled
// live table (no auth session / RPC scaffolding needed), so we can measure each model's
// real submitted code under load. Storage/ai don't hit Postgres; auth needs a live session
// and vector needs a live RPC — both excluded from v1 resource scoring (kept request-cost).
function resourceTasks() {
  return tasks.TEST.filter((t) => t.domain === 'db');
}

// Infer {table, columns, sample} by running the mock setup and reading row 0.
function introspect(task) {
  const be = createBackend();
  task.setup(be);
  // find the table the task seeded: scan known names from the task id's entity
  // (the mock stores tables internally; we read via admin.rawRows by trying the solution's table)
  // Simplest: parse the table name out of the oracle source.
  const m = task.oracle.match(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/i)
        || task.oracle.match(/rpc\(['"]match_([a-z_][a-z0-9_]*)['"]/i);
  if (!m) return null;
  const table = m[1];
  const rows = be.admin.rawRows(table);
  if (!rows.length) return null;
  return { table, sample: rows[0], n: rows.length };
}

// Map a JS sample value to a Postgres column type.
function pgType(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double precision';
  if (Array.isArray(v)) return 'jsonb';            // embeddings etc.
  return 'text';
}

function seedTable(table, sample, rows) {
  const cols = Object.keys(sample);
  const colDefs = cols.map((c) => {
    if (c === 'id') return 'id text PRIMARY KEY';
    return `${c} ${pgType(sample[c])}`;
  }).join(', ');

  dbQuery(`DROP TABLE IF EXISTS ${table}`);
  dbQuery(`CREATE TABLE ${table} (${colDefs})`);
  dbQuery(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  dbQuery(`CREATE POLICY ${table}_rw ON ${table} FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)`);

  // Build a generate_series INSERT that fills realistic, varied data at scale.
  // id = '<table>_'||g ; created_at = g ; text cols = a token ; numeric = g ; jsonb passthrough.
  const sel = cols.map((c) => {
    if (c === 'id') return `'${table}_'||g`;
    if (c === 'created_at') return 'g';
    if (c === 'user_id') return `(CASE WHEN g <= ${Math.floor(rows * 0.2)} THEN 'user_me' ELSE 'other_'||g END)`;
    const t = pgType(sample[c]);
    if (t === 'int') return 'g';
    if (t === 'double precision') return '(g::float/'+rows+')';
    if (t === 'jsonb') return `to_jsonb(ARRAY[g::float/${rows},g::float/${rows}])`;
    return `'${c}_'||g`;
  }).join(', ');
  dbQuery(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM generate_series(1,${rows}) g`);
  // Index the columns efficient solutions filter/order by — exactly like a production DB.
  // Good code (WHERE/ORDER BY/LIMIT on an indexed col) then does an index scan reading a few
  // rows; fetch-everything-and-filter-in-JS code seq-scans all N rows. That is the real,
  // RTT-immune server-cost gap the resource benchmark measures.
  if (cols.includes('created_at')) {
    dbQuery(`CREATE INDEX idx_${table}_created ON ${table}(created_at)`);
  }
  return cols;
}

function main() {
  const rows = parseInt(process.argv[2] || '100000', 10);
  const list = resourceTasks();
  const seeded = new Set();
  console.log(`Seeding live tables at ${rows} rows for ${list.length} resource tasks...\n`);
  const manifest = [];
  for (const task of list) {
    const info = introspect(task);
    if (!info) { console.log(`  SKIP ${task.id} (no table found)`); continue; }
    if (seeded.has(info.table)) { manifest.push({ id: task.id, table: info.table }); continue; }
    process.stdout.write(`  ${task.id.padEnd(30)} -> ${info.table} ... `);
    try {
      const cols = seedTable(info.table, info.sample, rows);
      seeded.add(info.table);
      manifest.push({ id: task.id, table: info.table, cols });
      console.log('ok');
    } catch (e) {
      console.log('ERR ' + String(e.message).slice(0, 80));
    }
  }
  require('fs').writeFileSync(require('path').join(__dirname, 'scale_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nseeded ${seeded.size} tables; wrote live/scale_manifest.json`);
}

if (require.main === module) main();
module.exports = { resourceTasks, introspect };
