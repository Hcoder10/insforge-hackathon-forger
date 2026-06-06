// forger-bench — tasks wired for the live audit. (docs/DESIGN.md §6)
//
// Each audit task carries: the mock setup, a live table name, the SAME oracle/naive code
// (byte-identical where possible; live variants only when a global/table name must differ),
// the weighted axes to compare, and a live correctness check. The point is to confirm the
// mock's cost RANKING matches the live backend's — not to re-grade.

'use strict';

// db.pagination — mock table 'posts' (57 rows) vs live table 'forger_posts' (57 rows seeded)
const pagination = {
  id: 'db.pagination',
  axes: ['dbOps', 'bytesRead', 'rowsReturned'],
  setupMock(be) {
    be.admin.createTable('posts');
    const rows = [];
    for (let i = 1; i <= 57; i++) rows.push({ id: `posts_${i}`, title: `Title ${i}`, body: 'x'.repeat(200), created_at: i });
    be.admin.seed('posts', rows);
  },
  // mock oracle/naive use 'posts'
  oracle:
    `async function solve(insforge){
      const { data, count } = await insforge.database.from('posts')
        .select('id, title', { count:'exact' }).order('created_at',{ascending:false}).range(10,19);
      return { items: data, total: count };
    }`,
  naive:
    `async function solve(insforge){
      const { data } = await insforge.database.from('posts').select('*');
      const sorted = data.sort((a,b)=>b.created_at-a.created_at);
      return { items: sorted.slice(10,20).map(r=>({id:r.id,title:r.title})), total: data.length };
    }`,
  // live oracle/naive: same logic, 'forger_posts'
  oracleLive:
    `async function solve(insforge){
      const { data, count } = await insforge.database.from('forger_posts')
        .select('id, title', { count:'exact' }).order('created_at',{ascending:false}).range(10,19);
      return { items: data, total: count };
    }`,
  naiveLive:
    `async function solve(insforge){
      const { data } = await insforge.database.from('forger_posts').select('*');
      const sorted = data.sort((a,b)=>b.created_at-a.created_at);
      return { items: sorted.slice(10,20).map(r=>({id:r.id,title:r.title})), total: data.length };
    }`,
  verifyLive(result) {
    return result && Array.isArray(result.items) && result.items.length === 10 && result.total === 57;
  },
};

module.exports = [pagination];
