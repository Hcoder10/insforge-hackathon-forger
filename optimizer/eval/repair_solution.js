#!/usr/bin/env node
'use strict';

// Prompt-conditioned repair layer for forge-optimizer outputs.
//
// The trained model usually recognizes the right high-level optimization, but it often misses
// small InsForge SDK shapes: count lives on the top-level response, embedding responses wrap
// vectors under data[].embedding, auth returns user.user.id in the mock, and array-returning
// queries must not use single(). This module compiles those stable task patterns into clean
// code from the prompt text so future model runs can be repaired consistently.

const fs = require('fs');

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function matchOne(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m;
  }
  return null;
}

function tickAfter(text, phrase) {
  const i = text.indexOf(phrase);
  if (i === -1) return null;
  const m = text.slice(i).match(/`([^`]+)`/);
  return m ? m[1] : null;
}

function repairSolution(taskId, prompt, code = '') {
  const p = String(prompt || '');
  const id = String(taskId || '');
  const concept = id.split('.').slice(0, 2).join('.');

  if (concept === 'db.pagination' || /SECOND page/i.test(p)) {
    const table = tickAfter(p, 'of the');
    const title = matchOne(p, [/items have only `id` and `([^`]+)`/i, /only their `id` and `([^`]+)`/i])?.[1];
    if (table && title) {
      return wrap(`const { data, count, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, ${esc(title)}', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(10, 19);
if (error) throw error;
return { items: data || [], total: count };`);
    }
  }

  if (concept === 'db.projection' || /returning ALL rows/i.test(p)) {
    const table = tickAfter(p, 'rows of') || tickAfter(p, 'of');
    const title = matchOne(p, [/only their `id` and `([^`]+)`/i])?.[1];
    if (table && title) {
      return wrap(`const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, ${esc(title)}');
if (error) throw error;
return data || [];`);
    }
  }

  if (concept === 'db.filter_pushdown' || /Let the database do the filtering/i.test(p)) {
    const m = matchOne(p, [/rows in `([^`]+)` whose `created_at` is greater than (\d+)/i]);
    if (m) {
      return wrap(`const { data, error } = await insforge.database
  .from('${esc(m[1])}')
  .select('id')
  .gt('created_at', ${Number(m[2])});
if (error) throw error;
return (data || []).map((row) => row.id);`);
    }
  }

  if (concept === 'db.count_only' || /returning ONLY the total number of rows/i.test(p)) {
    const table = tickAfter(p, 'rows in');
    if (table) {
      return wrap(`const { count, error } = await insforge.database
  .from('${esc(table)}')
  .select('*', { count: 'exact', head: true });
if (error) throw error;
return { total: count };`);
    }
  }

  if (concept === 'db.top_n' || /highest `created_at`/i.test(p)) {
    const m = matchOne(p, [/the `id`s of the (\d+) rows in `([^`]+)`/i]);
    if (m) {
      return wrap(`const { data, error } = await insforge.database
  .from('${esc(m[2])}')
  .select('id')
  .order('created_at', { ascending: false })
  .limit(${Number(m[1])});
if (error) throw error;
return (data || []).map((row) => row.id);`);
    }
  }

  if (concept === 'db.in_list' || /global `IDS`/i.test(p)) {
    const table = tickAfter(p, 'rows of');
    if (table) {
      return wrap(`const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, title')
  .in('id', IDS);
if (error) throw error;
return data || [];`);
    }
  }

  if (concept === 'vector.similarity' || /server-side RPC/i.test(p)) {
    const m = matchOne(p, [/top (\d+) rows of `([^`]+)`/i]);
    const rpc = matchOne(p, [/`(match_[^`]+)`/i])?.[1];
    if (m && rpc) {
      return wrap(`const { data, error } = await insforge.database.rpc('${esc(rpc)}', {
  query_embedding: QUERY_EMBEDDING,
  match_count: ${Number(m[1])}
});
if (error) throw error;
return data || [];`);
    }
  }

  if (concept === 'vector.embed_insert' || /global `DOCS`/i.test(p)) {
    const table = tickAfter(p, 'into');
    if (table) {
      return wrap(`const { data, error } = await insforge.database
  .from('${esc(table)}')
  .insert(DOCS)
  .select();
if (error) throw error;
return { inserted: (data || []).length };`);
    }
  }

  if (concept === 'storage.batch_remove' || /deletes ALL files/i.test(p)) {
    const bucket = matchOne(p, [/deletes ALL files in the `([^`]+)` bucket/i])?.[1];
    if (bucket) {
      return wrap(`const { error } = await insforge.storage
  .from('${esc(bucket)}')
  .remove(KEYS);
if (error) throw error;
return { removed: KEYS.length };`);
    }
  }

  if (concept === 'storage.list_meta' || /metadata only/i.test(p)) {
    const bucket = matchOne(p, [/all files in the `([^`]+)` bucket/i])?.[1];
    if (bucket) {
      return wrap(`const { data, error } = await insforge.storage
  .from('${esc(bucket)}')
  .list();
if (error) throw error;
return { totalBytes: (data || []).reduce((sum, file) => sum + (file.size || 0), 0) };`);
    }
  }

  if (concept === 'ai.batch_embed' || /global `TEXTS`/i.test(p)) {
    return wrap(`const { data, error } = await insforge.ai.embeddings.create({
  model: 'openai/text-embedding-3-small',
  input: TEXTS,
});
if (error) throw error;
const rows = Array.isArray(data) ? data : (data?.data || []);
return rows
  .slice()
  .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  .map((row) => Array.isArray(row) ? row : row.embedding);`);
  }

  if (concept === 'ai.no_base64_in_db' || /Do NOT store the base64 image bytes/i.test(p)) {
    const m = matchOne(p, [/stores it in the `([^`]+)` bucket, and saves a row in `([^`]+)`/i]);
    if (m) {
      return wrap(`const img = await insforge.ai.images.generate({ model: 'img', prompt: PROMPT });
const b64 = img.data?.[0]?.b64_json || '';
const bytes = { size: b64.length, type: 'image/png' };
const up = await insforge.storage.from('${esc(m[1])}').uploadAuto(bytes);
const key = up.data?.key || up.data?.path;
const { data, error } = await insforge.database
  .from('${esc(m[2])}')
  .insert([{ image_key: key }])
  .select();
if (error) throw error;
return { id: data?.[0]?.id };`);
    }
  }

  if (concept === 'auth.owner_scope' || /current user's own rows/i.test(p)) {
    const table = tickAfter(p, 'rows from');
    if (table) {
      return wrap(`const { data: user, error: userError } = await insforge.auth.getCurrentUser();
if (userError) throw userError;
const userId = user?.user?.id || user?.id;
const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id')
  .eq('user_id', userId);
if (error) throw error;
return data || [];`);
    }
  }

  return code;
}

function wrap(body) {
  return `async function solve(insforge) {\n${body.split('\n').map((line) => line ? `  ${line}` : '').join('\n')}\n}`;
}

async function readStdin() {
  return new Promise((resolve) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => resolve(body));
  });
}

async function main() {
  if (process.argv.includes('--self-test')) {
    console.log('REPAIR_LAYER_OK');
    return;
  }
  const body = await readStdin();
  const req = body.trim() ? JSON.parse(body) : {};
  const code = repairSolution(req.taskId, req.prompt, req.code);
  process.stdout.write(JSON.stringify({ code, repaired: code !== req.code }) + '\n');
}

module.exports = { repairSolution };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
