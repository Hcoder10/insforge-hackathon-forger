// forger-bench — Auth + RLS concepts. (docs/DESIGN.md §5, §7)
//
// The mock's RLS: a query for the current user's rows should filter server-side via .eq on
// the owner column. The naive fetches everything and filters by user in JS — extra bytes and
// rows that, with real RLS, it wouldn't even be allowed to see.
'use strict';
const { runSolve } = require('./db');

// CONCEPT: owner_scope — fetch only the current user's rows (server-filtered), not all+filter
function ownerScope(split, idx, e) {
  const { table: t, total, mine } = e;
  return {
    id: `auth.owner_scope.${split}${idx}`, domain: 'auth', concept: 'owner_scope', split,
    weights: { bytesRead: 0.6, rowsReturned: 0.4 },
    prompt:
      `Write \`async function solve(insforge)\` returning the current user's own rows from ` +
      `\`${t}\` (column \`user_id\`) as \`{ id }[]\`. Get the user id from ` +
      `\`insforge.auth.getCurrentUser()\`, then let the database filter by owner.`,
    setup(be) {
      be.admin.createTable(t);
      const me = 'user_me';
      be.admin.createUser({ id: me, email: 'me@x.com', password: 'p' });
      be.admin.setCurrentUser(me);
      const rows = [];
      for (let i = 1; i <= total; i++) rows.push({ id: `${t}_${i}`, user_id: i <= mine ? me : `other_${i}`, body: 'x'.repeat(100) });
      be.admin.seed(t, rows);
    },
    run: runSolve,
    verify(be, ctx, r) { return Array.isArray(r) && r.length === mine && r.every((x) => x.id); },
    oracle:
      `async function solve(insforge){
        const { data: u } = await insforge.auth.getCurrentUser();
        const { data } = await insforge.database.from('${t}').select('id').eq('user_id', u.user.id);
        return data;
      }`,
    naive:
      `async function solve(insforge){
        const { data: u } = await insforge.auth.getCurrentUser();
        const { data } = await insforge.database.from('${t}').select('*');
        return data.filter(r=>r.user_id===u.user.id).map(r=>({id:r.id}));
      }`,
    mid: [],
  };
}

const POOLS = {
  owner: { train: { table: 'todos', total: 60, mine: 12 },
    test: [{ table: 'notes', total: 56, mine: 10 }, { table: 'bookmarks', total: 64, mine: 16 }, { table: 'drafts', total: 50, mine: 8 }] },
};

function build(factory, pool) {
  const out = [factory('train', 1, pool.train)];
  pool.test.forEach((e, i) => out.push(factory('test', i + 1, e)));
  return out;
}

module.exports = { tasks: [...build(ownerScope, POOLS.owner)] };
