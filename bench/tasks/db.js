// forger-bench — Database concepts. (docs/DESIGN.md §5, §7)
//
// Each concept is a factory parameterized by an ENTITY (table + column names + data), so we
// can mint a `train` instance and N sealed `test` instances with DISTINCT entities. Test
// entities never overlap train entities -> contamination control (§7).
'use strict';

// ---- candidate compilation (shared) -------------------------------------
function compile(code) {
  // candidate defines `async function solve(insforge){...}`; return it
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return solve;`)();
}
async function runSolve(be, code) {
  const fn = compile(code);
  return fn(be.insforge);
}

// Run a candidate with task globals set for the FULL duration of execution. Must await
// before clearing — otherwise the global is deleted at the first `await` inside solve, and
// any later reference to it throws "X is not defined". (Use for every global-using task.)
async function withGlobals(globals, fn) {
  for (const [k, v] of Object.entries(globals)) global[k] = v;
  try { return await fn(); }
  finally { for (const k of Object.keys(globals)) delete global[k]; }
}

// Seed a table of N rows with id/<title>/<body>/created_at.
function seedRows(be, t, n, titleCol, bodyCol) {
  be.admin.createTable(t);
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: `${t}_${i}`, [titleCol]: `${titleCol} ${i}`, [bodyCol]: 'x'.repeat(200), created_at: i });
  }
  be.admin.seed(t, rows);
}

// =========================================================================
// CONCEPT: pagination — page 2 (size 10) newest-first + total, minimal fetch
// =========================================================================
function pagination(split, idx, e) {
  const { table: t, titleCol, total } = e;
  return {
    id: `db.pagination.${split}${idx}`, domain: 'db', concept: 'pagination', split,
    weights: { dbOps: 0.4, bytesRead: 0.4, rowsReturned: 0.2 },
    prompt:
      `Write \`async function solve(insforge)\` that returns the SECOND page (page size 10, ` +
      `0-indexed page 1) of the \`${t}\` table ordered by \`created_at\` descending, plus the ` +
      `total row count. Return \`{ items, total }\` where items have only \`id\` and \`${titleCol}\`. ` +
      `Minimize round-trips and bytes.`,
    setup(be) { seedRows(be, t, total, titleCol, 'body'); },
    run: runSolve,
    verify(be, ctx, r) {
      if (!r || !Array.isArray(r.items) || r.total !== total || r.items.length !== 10) return false;
      if (r.items[0].id !== `${t}_${total - 10}`) return false;
      return Object.keys(r.items[0]).sort().join(',') === ['id', titleCol].sort().join(',');
    },
    oracle:
      `async function solve(insforge){
        const { data, count } = await insforge.database.from('${t}')
          .select('id, ${titleCol}', { count:'exact' }).order('created_at',{ascending:false}).range(10,19);
        return { items: data, total: count };
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        const s = data.sort((a,b)=>b.created_at-a.created_at);
        return { items: s.slice(10,20).map(r=>({id:r.id,${titleCol}:r.${titleCol}})), total: data.length };
      }`,
    mid: [
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*').order('created_at',{ascending:false}).range(10,19);
        const { count } = await insforge.database.from('${t}').select('*',{count:'exact',head:true});
        return { items: data.map(r=>({id:r.id,${titleCol}:r.${titleCol}})), total: count };
      }`,
    ],
  };
}

// =========================================================================
// CONCEPT: column_projection — fetch only 2 columns, not the whole row
// =========================================================================
function projection(split, idx, e) {
  const { table: t, titleCol, total } = e;
  return {
    id: `db.projection.${split}${idx}`, domain: 'db', concept: 'column_projection', split,
    // both return all rows -> rowsReturned is inert; only transferred bytes separate them
    weights: { bytesRead: 1.0 },
    prompt:
      `Write \`async function solve(insforge)\` returning ALL rows of \`${t}\` but only their ` +
      `\`id\` and \`${titleCol}\` (as \`{ id, ${titleCol} }\`). Fetch as few bytes as possible.`,
    setup(be) { seedRows(be, t, total, titleCol, 'body'); },
    run: runSolve,
    verify(be, ctx, r) {
      if (!Array.isArray(r) || r.length !== total) return false;
      return Object.keys(r[0]).sort().join(',') === ['id', titleCol].sort().join(',');
    },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('id, ${titleCol}');
        return data;
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        return data.map(r=>({id:r.id,${titleCol}:r.${titleCol}}));
      }`,
    mid: [],
  };
}

// =========================================================================
// CONCEPT: filter_pushdown — filter on the server, not in JS
// =========================================================================
function filterPushdown(split, idx, e) {
  const { table: t, total } = e;
  const threshold = Math.floor(total / 2);
  return {
    id: `db.filter_pushdown.${split}${idx}`, domain: 'db', concept: 'filter_pushdown', split,
    // the mock "scans" the full table either way (rowsScanned inert); the win is in what
    // crosses the wire — naive pulls every row, oracle only the matching half
    weights: { bytesRead: 0.6, rowsReturned: 0.4 },
    prompt:
      `Write \`async function solve(insforge)\` returning the \`id\`s of rows in \`${t}\` whose ` +
      `\`created_at\` is greater than ${threshold}, as a string[]. Let the database do the filtering.`,
    setup(be) { seedRows(be, t, total, 'title', 'body'); },
    run: runSolve,
    verify(be, ctx, r) {
      if (!Array.isArray(r)) return false;
      return r.length === total - threshold && r.every((id) => typeof id === 'string');
    },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('id').gt('created_at', ${threshold});
        return data.map(r=>r.id);
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        return data.filter(r=>r.created_at > ${threshold}).map(r=>r.id);
      }`,
    mid: [],
  };
}

// =========================================================================
// CONCEPT: count_only — get a count without dragging rows back
// =========================================================================
function countOnly(split, idx, e) {
  const { table: t, total } = e;
  return {
    id: `db.count_only.${split}${idx}`, domain: 'db', concept: 'count_only', split,
    weights: { bytesRead: 0.6, rowsReturned: 0.4 },
    prompt:
      `Write \`async function solve(insforge)\` returning ONLY the total number of rows in ` +
      `\`${t}\` as \`{ total: <number> }\`. Do not transfer row data.`,
    setup(be) { seedRows(be, t, total, 'title', 'body'); },
    run: runSolve,
    verify(be, ctx, r) { return r && r.total === total; },
    oracle:
      `async function solve(insforge){
        const { count } = await insforge.database.from('${t}').select('*',{count:'exact',head:true});
        return { total: count };
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        return { total: data.length };
      }`,
    mid: [
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('id');
        return { total: data.length };
      }`,
    ],
  };
}

// =========================================================================
// CONCEPT: top_n — highest N by a column, server-ordered + limited
// =========================================================================
function topN(split, idx, e) {
  const { table: t, total } = e;
  const n = 5;
  return {
    id: `db.top_n.${split}${idx}`, domain: 'db', concept: 'top_n', split,
    weights: { bytesRead: 0.6, rowsReturned: 0.4 },
    prompt:
      `Write \`async function solve(insforge)\` returning the \`id\`s of the ${n} rows in ` +
      `\`${t}\` with the highest \`created_at\`, highest first, as a string[]. Use server-side ` +
      `order + limit.`,
    setup(be) { seedRows(be, t, total, 'title', 'body'); },
    run: runSolve,
    verify(be, ctx, r) {
      if (!Array.isArray(r) || r.length !== n) return false;
      return r[0] === `${t}_${total}` && r[n - 1] === `${t}_${total - n + 1}`;
    },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('id').order('created_at',{ascending:false}).limit(${n});
        return data.map(r=>r.id);
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        return data.sort((a,b)=>b.created_at-a.created_at).slice(0,${n}).map(r=>r.id);
      }`,
    mid: [],
  };
}

// =========================================================================
// CONCEPT: in_list — fetch a set of ids in ONE query, not N
// =========================================================================
function inList(split, idx, e) {
  const { table: t, total } = e;
  const ids = [2, 5, 9, 14, 20].filter((i) => i <= total).map((i) => `${t}_${i}`);
  return {
    id: `db.in_list.${split}${idx}`, domain: 'db', concept: 'in_list', split,
    weights: { dbOps: 0.7, bytesRead: 0.3 },
    prompt:
      `Write \`async function solve(insforge)\` that fetches the rows of \`${t}\` whose id is in ` +
      `the global \`IDS\` (string[]), returning them as \`{ id, title }[]\`. Use ONE query.`,
    setup(be) { seedRows(be, t, total, 'title', 'body'); be.IDS = ids; },
    run(be, code) { return withGlobals({ IDS: be.IDS }, () => runSolve(be, code)); },
    verify(be, ctx, r) { return Array.isArray(r) && r.length === ids.length; },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('id, title').in('id', IDS);
        return data;
      }`,
    naive:
      `async function solve(insforge){
        const out = [];
        for (const id of IDS){
          const { data } = await insforge.database.from('${t}').select('id, title').eq('id', id).single();
          out.push(data);
        }
        return out;
      }`,
    mid: [],
  };
}

// ---- entity pools (train vs sealed test — DISTINCT names) ----------------
// Each concept gets a train entity + 3 test entities. Test tables never reuse train names.
const POOLS = {
  pagination: { train: { table: 'posts', titleCol: 'title', total: 53 },
    test: [{ table: 'articles', titleCol: 'headline', total: 57 },
           { table: 'tickets', titleCol: 'subject', total: 61 },
           { table: 'recipes', titleCol: 'name', total: 48 }] },
  projection: { train: { table: 'profiles', titleCol: 'name', total: 40 },
    test: [{ table: 'books', titleCol: 'title', total: 44 },
           { table: 'movies', titleCol: 'title', total: 37 },
           { table: 'songs', titleCol: 'title', total: 50 }] },
  filter: { train: { table: 'orders', total: 60 },
    test: [{ table: 'invoices', total: 56 },
           { table: 'shipments', total: 64 },
           { table: 'payments', total: 52 }] },
  count: { train: { table: 'events', total: 70 },
    test: [{ table: 'logs', total: 66 },
           { table: 'visits', total: 74 },
           { table: 'clicks', total: 58 }] },
  topn: { train: { table: 'scores', total: 45 },
    test: [{ table: 'leaderboard', total: 49 },
           { table: 'rankings', total: 41 },
           { table: 'results', total: 55 }] },
  inlist: { train: { table: 'products', total: 40 },
    test: [{ table: 'items', total: 44 },
           { table: 'skus', total: 38 },
           { table: 'parts', total: 50 }] },
};

function buildConcept(factory, pool) {
  const out = [factory('train', 1, pool.train)];
  pool.test.forEach((e, i) => out.push(factory('test', i + 1, e)));
  return out;
}

const tasks = [
  ...buildConcept(pagination, POOLS.pagination),
  ...buildConcept(projection, POOLS.projection),
  ...buildConcept(filterPushdown, POOLS.filter),
  ...buildConcept(countOnly, POOLS.count),
  ...buildConcept(topN, POOLS.topn),
  ...buildConcept(inList, POOLS.inlist),
];

// Factories exposed by concept name so external tools (e.g. forge-optimizer's data
// generator) can mint fresh contamination-free instances on arbitrary entities.
const factories = {
  pagination, column_projection: projection, filter_pushdown: filterPushdown,
  count_only: countOnly, top_n: topN, in_list: inList,
};

module.exports = { tasks, runSolve, compile, seedRows, withGlobals, factories };
