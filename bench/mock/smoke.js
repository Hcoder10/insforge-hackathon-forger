// forger-bench — mock sanity check. Prints SMOKE_OK or throws.
'use strict';

const assert = require('assert');
const { createBackend } = require('./index');

async function main() {
  const { insforge, metrics, admin } = createBackend();

  // database: seed, projected select, count
  admin.createTable('posts');
  admin.seed('posts', [
    { id: 'p1', title: 'A', body: 'xxxx', created_at: 1 },
    { id: 'p2', title: 'B', body: 'yyyy', created_at: 2 },
  ]);
  const { data, count } = await insforge.database.from('posts')
    .select('id, title', { count: 'exact' }).order('created_at', { ascending: false }).range(0, 0);
  assert.strictEqual(data.length, 1, 'range -> 1 row');
  assert.strictEqual(data[0].id, 'p2', 'desc order');
  assert.deepStrictEqual(Object.keys(data[0]).sort(), ['id', 'title'], 'projection');
  assert.strictEqual(count, 2, 'count exact');
  assert.strictEqual(metrics.dbOps, 1, 'one db op');
  assert.ok(metrics.cpuOps > 0, 'cpu work counted');
  assert.ok(metrics.diskBytes > 0, 'disk bytes counted');
  assert.ok(metrics.memoryBytes > 0, 'memory peak counted');

  // insert array form + returning
  const ins = await insforge.database.from('posts').insert([{ title: 'C' }]).select();
  assert.strictEqual(ins.data.length, 1, 'insert returns row');
  assert.ok(metrics.writes >= 1, 'write counted');

  // storage batch remove = one op
  admin.createBucket('up');
  admin.putFile('up', 'a', 10); admin.putFile('up', 'b', 10);
  const diskBeforeDownload = metrics.diskBytes;
  await insforge.storage.from('up').download('a');
  assert.ok(metrics.diskBytes > diskBeforeDownload, 'storage disk bytes counted');
  const before = metrics.storageOps;
  await insforge.storage.from('up').remove(['a', 'b']);
  assert.strictEqual(metrics.storageOps - before, 1, 'batch remove = 1 op');

  // ai batched embeddings = one call
  const ac = metrics.aiCalls;
  await insforge.ai.embeddings.create({ model: 'm', input: ['x', 'y', 'z'] });
  assert.strictEqual(metrics.aiCalls - ac, 1, 'batch embed = 1 call');

  // rpc
  admin.registerRpc('ping', () => [{ ok: true }]);
  const r = await insforge.database.rpc('ping', {});
  assert.strictEqual(r.data[0].ok, true, 'rpc works');

  console.log('SMOKE_OK');
}

main().catch((e) => { console.error('SMOKE_FAIL', e); process.exit(1); });
