// forger-bench — AI concepts. (docs/DESIGN.md §5, §7)
'use strict';
const { runSolve, withGlobals } = require('./db');

const MODEL = 'openai/text-embedding-3-small';

// CONCEPT: batch_embed — one embeddings.create({input:[...]}) vs a loop of single calls
function batchEmbed(split, idx, e) {
  const { count: n } = e;
  return {
    id: `ai.batch_embed.${split}${idx}`, domain: 'ai', concept: 'batch_embed', split,
    weights: { aiCalls: 0.7, aiTokens: 0.3 },
    prompt:
      `Write \`async function solve(insforge)\` that embeds ALL strings in the global \`TEXTS\` ` +
      `(string[]) with model '${MODEL}' and returns the vectors (number[][]) in order. Use as ` +
      `few AI calls as possible.`,
    setup(be) { be.TEXTS = Array.from({ length: n }, (_, i) => `sentence number ${i + 1}`); },
    run(be, code) { return withGlobals({ TEXTS: be.TEXTS }, () => runSolve(be, code)); },
    verify(be, ctx, r) { return Array.isArray(r) && r.length === n && Array.isArray(r[0]) && r[0].length === 8; },
    oracle:
      `async function solve(insforge){ const res = await insforge.ai.embeddings.create({ model:'${MODEL}', input: TEXTS }); return res.data.map(d=>d.embedding); }`,
    naive:
      `async function solve(insforge){ const out=[]; for (const t of TEXTS){ const r = await insforge.ai.embeddings.create({ model:'${MODEL}', input: t }); out.push(r.data[0].embedding); } return out; }`,
    mid: [
      `async function solve(insforge){ const h=Math.ceil(TEXTS.length/2); const a=await insforge.ai.embeddings.create({model:'${MODEL}',input:TEXTS.slice(0,h)}); const b=await insforge.ai.embeddings.create({model:'${MODEL}',input:TEXTS.slice(h)}); return [...a.data,...b.data].map(d=>d.embedding); }`,
    ],
  };
}

// CONCEPT: no_base64_in_db — store a generated image in storage, save the KEY (not base64) in db
function noBase64(split, idx, e) {
  const { table: t, bucket: b } = e;
  return {
    id: `ai.no_base64_in_db.${split}${idx}`, domain: 'ai', concept: 'no_base64_in_db', split,
    weights: { bytesWritten: 1.0 },
    prompt:
      `Write \`async function solve(insforge)\` that generates an image (model 'img', prompt in ` +
      `global \`PROMPT\`), stores it in the \`${b}\` bucket, and saves a row in \`${t}\` ` +
      `referencing it. Return \`{ id }\` of the row. Do NOT store the base64 image bytes in the ` +
      `database — store the storage key.`,
    setup(be) { be.admin.createTable(t); be.admin.createBucket(b); be.PROMPT = 'a mountain at sunset'; },
    run(be, code) { return withGlobals({ PROMPT: be.PROMPT }, () => runSolve(be, code)); },
    verify(be, ctx, r) {
      if (!r || !r.id) return false;
      const row = be.admin.rawRows(t)[0];
      if (!row) return false;
      // the stored row must reference a key and must NOT embed a long base64 blob
      const hasKey = !!row.image_key;
      const noBlob = !Object.values(row).some((v) => typeof v === 'string' && v.length > 256);
      return hasKey && noBlob;
    },
    oracle:
      `async function solve(insforge){
        const img = await insforge.ai.images.generate({ model:'img', prompt: PROMPT });
        const b64 = img.data[0].b64_json;
        const bytes = { size: b64.length, type:'image/png' };
        const up = await insforge.storage.from('${b}').uploadAuto(bytes);
        const { data } = await insforge.database.from('${t}').insert([{ image_key: up.data.key }]).select();
        return { id: data[0].id };
      }`,
    naive:
      `async function solve(insforge){
        const img = await insforge.ai.images.generate({ model:'img', prompt: PROMPT });
        const b64 = img.data[0].b64_json.repeat(64);
        const { data } = await insforge.database.from('${t}').insert([{ image_key:'k', image_b64: b64 }]).select();
        return { id: data[0].id };
      }`,
    mid: [],
  };
}

const POOLS = {
  embed: { train: { count: 20 }, test: [{ count: 24 }, { count: 16 }, { count: 30 }] },
  base64: { train: { table: 'generations', bucket: 'ai_images' },
    test: [{ table: 'artworks', bucket: 'art' }, { table: 'thumbnails', bucket: 'thumbs' }, { table: 'renders', bucket: 'renders' }] },
};

function build(factory, pool) {
  const out = [factory('train', 1, pool.train)];
  pool.test.forEach((e, i) => out.push(factory('test', i + 1, e)));
  return out;
}

module.exports = { tasks: [...build(batchEmbed, POOLS.embed), ...build(noBase64, POOLS.base64)] };
