// forger-bench — Vector / RAG concepts. (docs/DESIGN.md §5, §7)
'use strict';
const { runSolve, withGlobals } = require('./db');

// CONCEPT: similarity_search — server-side RPC top-k vs client-side distance over all rows
function similarity(split, idx, e) {
  const { table: t, total } = e;
  const k = 5;
  return {
    id: `vector.similarity.${split}${idx}`, domain: 'vector', concept: 'similarity_search', split,
    weights: { dbOps: 0.3, bytesRead: 0.5, rowsReturned: 0.2 },
    prompt:
      `Write \`async function solve(insforge)\` returning the top ${k} rows of \`${t}\` most ` +
      `similar to the global \`QUERY_EMBEDDING\` (number[]), using the server-side RPC ` +
      `\`match_${t}\` (args { query_embedding, match_count }). Return \`{ id, content }[]\`. ` +
      `Do the distance math on the server.`,
    setup(be) {
      be.admin.createTable(t);
      const rows = [];
      for (let i = 1; i <= total; i++) rows.push({ id: `${t}_${i}`, content: `doc ${i}`, embedding: new Array(8).fill(i / total) });
      be.admin.seed(t, rows);
      be.admin.registerRpc(`match_${t}`, (args, { tables }) => {
        const q = args.query_embedding;
        const rs = tables.get(t).rows;
        const d = (em) => em.reduce((s, v, j) => s + (v - q[j]) ** 2, 0);
        return [...rs].sort((a, b) => d(a.embedding) - d(b.embedding)).slice(0, args.match_count).map((r) => ({ id: r.id, content: r.content }));
      });
      be.QUERY_EMBEDDING = new Array(8).fill(1.0);
    },
    run(be, code) { return withGlobals({ QUERY_EMBEDDING: be.QUERY_EMBEDDING }, () => runSolve(be, code)); },
    verify(be, ctx, r) {
      if (!Array.isArray(r) || r.length !== k || r[0].id !== `${t}_${total}`) return false;
      return Object.keys(r[0]).sort().join(',') === 'content,id';
    },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.rpc('match_${t}', { query_embedding: QUERY_EMBEDDING, match_count: ${k} });
        return data;
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').select('*');
        const q = QUERY_EMBEDDING, d = e => e.reduce((s,v,j)=>s+(v-q[j])**2,0);
        return data.sort((a,b)=>d(a.embedding)-d(b.embedding)).slice(0,${k}).map(r=>({id:r.id,content:r.content}));
      }`,
    mid: [
      `async function solve(insforge){
        await insforge.database.from('${t}').select('id');
        const { data } = await insforge.database.rpc('match_${t}', { query_embedding: QUERY_EMBEDDING, match_count: ${k} });
        return data;
      }`,
    ],
  };
}

// CONCEPT: embed_insert — batch-insert embeddings in one write vs row-by-row
function embedInsert(split, idx, e) {
  const { table: t, count } = e;
  return {
    id: `vector.embed_insert.${split}${idx}`, domain: 'vector', concept: 'embed_insert', split,
    // total rows written is identical (writes inert); the win is one round-trip vs N
    weights: { dbOps: 1.0 },
    prompt:
      `Write \`async function solve(insforge)\` that inserts ALL rows from the global \`DOCS\` ` +
      `(array of { content, embedding }) into \`${t}\`. Return \`{ inserted: <number> }\`. ` +
      `Use the fewest writes.`,
    setup(be) {
      be.admin.createTable(t);
      be.DOCS = Array.from({ length: count }, (_, i) => ({ content: `c${i}`, embedding: new Array(8).fill(i / count) }));
    },
    run(be, code) { return withGlobals({ DOCS: be.DOCS }, () => runSolve(be, code)); },
    verify(be, ctx, r) { return r && r.inserted === count && be.admin.rawRows(t).length === count; },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.database.from('${t}').insert(DOCS).select();
        return { inserted: data.length };
      }`,
    naive:
      `async function solve(insforge){
        let n=0;
        for (const d of DOCS){ const { data } = await insforge.database.from('${t}').insert([d]).select(); n+=data.length; }
        return { inserted: n };
      }`,
    mid: [],
  };
}

const POOLS = {
  similarity: { train: { table: 'documents', total: 200 },
    test: [{ table: 'chunks', total: 180 }, { table: 'passages', total: 220 }, { table: 'memories', total: 160 }] },
  embed: { train: { table: 'doc_vectors', count: 30 },
    test: [{ table: 'note_vectors', count: 24 }, { table: 'page_vectors', count: 36 }, { table: 'kb_vectors', count: 28 }] },
};

function build(factory, pool) {
  const out = [factory('train', 1, pool.train)];
  pool.test.forEach((e, i) => out.push(factory('test', i + 1, e)));
  return out;
}

module.exports = { tasks: [...build(similarity, POOLS.similarity), ...build(embedInsert, POOLS.embed)] };
