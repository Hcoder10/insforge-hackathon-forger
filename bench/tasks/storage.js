// forger-bench — Storage concepts. (docs/DESIGN.md §5, §7)
'use strict';
const { runSolve, withGlobals } = require('./db');

// CONCEPT: batch_remove — one remove([keys]) vs per-file remove() (and don't download first)
function batchRemove(split, idx, e) {
  const { bucket: b, count: n } = e;
  return {
    id: `storage.batch_remove.${split}${idx}`, domain: 'storage', concept: 'batch_remove', split,
    weights: { storageOps: 0.8, storageBytes: 0.2 },
    prompt:
      `Write \`async function solve(insforge)\` that deletes ALL files in the \`${b}\` bucket ` +
      `(keys in the global \`KEYS\`). Return \`{ removed: <number> }\`. Use the fewest storage ops.`,
    setup(be) {
      be.admin.createBucket(b);
      be.KEYS = Array.from({ length: n }, (_, i) => `file-${i + 1}.bin`);
      be.KEYS.forEach((k) => be.admin.putFile(b, k, 1024));
    },
    run(be, code) { return withGlobals({ KEYS: be.KEYS }, () => runSolve(be, code)); },
    verify(be, ctx, r) { return r && r.removed === n; },
    oracle:
      `async function solve(insforge){ await insforge.storage.from('${b}').remove(KEYS); return { removed: KEYS.length }; }`,
    naive:
      `async function solve(insforge){ let n=0; for (const k of KEYS){ await insforge.storage.from('${b}').remove(k); n++; } return { removed:n }; }`,
    mid: [
      `async function solve(insforge){ for (const k of KEYS){ await insforge.storage.from('${b}').download(k); } await insforge.storage.from('${b}').remove(KEYS); return { removed: KEYS.length }; }`,
    ],
  };
}

// CONCEPT: list_meta — use list() for sizes instead of downloading every file
function listMeta(split, idx, e) {
  const { bucket: b, count: n, bytesEach } = e;
  return {
    id: `storage.list_meta.${split}${idx}`, domain: 'storage', concept: 'list_meta', split,
    weights: { storageBytes: 0.7, storageOps: 0.3 },
    prompt:
      `Write \`async function solve(insforge)\` returning the TOTAL size in bytes of all files ` +
      `in the \`${b}\` bucket as \`{ totalBytes: <number> }\`. Read metadata only — do not ` +
      `download file contents.`,
    setup(be) {
      be.admin.createBucket(b);
      for (let i = 1; i <= n; i++) be.admin.putFile(b, `f-${i}.bin`, bytesEach);
    },
    run: runSolve,
    verify(be, ctx, r) { return r && r.totalBytes === n * bytesEach; },
    oracle:
      `async function solve(insforge){
        const { data } = await insforge.storage.from('${b}').list();
        return { totalBytes: data.reduce((s,f)=>s+f.size,0) };
      }`,
    naive:
      `async function solve(insforge){
        const { data } = await insforge.storage.from('${b}').list();
        let total=0;
        for (const f of data){ const { data: blob } = await insforge.storage.from('${b}').download(f.key); total += blob.size; }
        return { totalBytes: total };
      }`,
    mid: [],
  };
}

const POOLS = {
  remove: { train: { bucket: 'uploads', count: 25 },
    test: [{ bucket: 'avatars', count: 30 }, { bucket: 'attachments', count: 20 }, { bucket: 'exports', count: 28 }] },
  listmeta: { train: { bucket: 'media', count: 15, bytesEach: 4096 },
    test: [{ bucket: 'photos', count: 18, bytesEach: 8192 }, { bucket: 'docs', count: 12, bytesEach: 2048 }, { bucket: 'backups', count: 20, bytesEach: 16384 }] },
};

function build(factory, pool) {
  const out = [factory('train', 1, pool.train)];
  pool.test.forEach((e, i) => out.push(factory('test', i + 1, e)));
  return out;
}

module.exports = { tasks: [...build(batchRemove, POOLS.remove), ...build(listMeta, POOLS.listmeta)] };
