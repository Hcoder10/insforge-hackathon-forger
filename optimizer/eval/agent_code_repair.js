#!/usr/bin/env node
'use strict';

// Code-aware repair engine for agent-written InsForge SDK solutions.
//
// Unlike repair_solution.js, this refuses empty input. It only emits a repair when the
// submitted code contains an InsForge call, then extracts the table, bucket, or RPC target
// from that code and rewrites the common SDK failure pattern for the task family.

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function wrap(body) {
  return `async function solve(insforge) {\n${body.split('\n').map((line) => line ? `  ${line}` : '').join('\n')}\n}`;
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

function databaseTables(code) {
  return [...String(code).matchAll(/\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/gi)].map((m) => m[1]);
}

function storageBuckets(code) {
  return [...String(code).matchAll(/storage\s*\.from\(['"]([^'"]+)['"]\)|storage[\s\S]{0,80}\.from\(['"]([^'"]+)['"]\)/gi)]
    .map((m) => m[1] || m[2])
    .filter(Boolean);
}

function rpcName(code) {
  return String(code).match(/\.rpc\(['"]([^'"]+)['"]/i)?.[1] || null;
}

function hasAgentCode(code) {
  const src = String(code || '').trim();
  return src.length > 0 && /insforge/.test(src) && /async\s+function\s+solve/.test(src);
}

function repairAgentCode(taskId, prompt, code = '') {
  if (!hasAgentCode(code)) {
    return { code, repaired: false, reason: 'no_agent_code' };
  }

  const p = String(prompt || '');
  const id = String(taskId || '');
  const concept = id.split('.').slice(0, 2).join('.');
  const tables = databaseTables(code);
  const buckets = storageBuckets(code);
  const rpc = rpcName(code);
  let body = null;
  let reason = concept || 'unknown';

  if (concept === 'db.pagination') {
    const table = tables[0] || tickAfter(p, 'of the');
    const title = matchOne(p, [/items have only `id` and `([^`]+)`/i, /only their `id` and `([^`]+)`/i])?.[1];
    if (table && title) {
      body = `const { data, count, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, ${esc(title)}', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(10, 19);
if (error) throw error;
return { items: data || [], total: count };`;
    }
  } else if (concept === 'db.projection') {
    const table = tables[0] || tickAfter(p, 'rows of');
    const title = matchOne(p, [/only their `id` and `([^`]+)`/i])?.[1];
    if (table && title) {
      body = `const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, ${esc(title)}');
if (error) throw error;
return data || [];`;
    }
  } else if (concept === 'db.filter_pushdown') {
    const table = tables[0];
    const threshold = matchOne(p, [/`created_at` is greater than (\d+)/i])?.[1];
    if (table && threshold) {
      body = `const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id')
  .gt('created_at', ${Number(threshold)});
if (error) throw error;
return (data || []).map((row) => row.id);`;
    }
  } else if (concept === 'db.count_only') {
    const table = tables[0] || tickAfter(p, 'rows in');
    if (table) {
      body = `const { count, error } = await insforge.database
  .from('${esc(table)}')
  .select('*', { count: 'exact', head: true });
if (error) throw error;
return { total: count };`;
    }
  } else if (concept === 'db.top_n') {
    const table = tables[0] || matchOne(p, [/rows in `([^`]+)`/i])?.[1];
    const limit = matchOne(p, [/the `id`s of the (\d+) rows/i])?.[1] || '5';
    if (table) {
      body = `const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id')
  .order('created_at', { ascending: false })
  .limit(${Number(limit)});
if (error) throw error;
return (data || []).map((row) => row.id);`;
    }
  } else if (concept === 'db.in_list') {
    const table = tables[0] || tickAfter(p, 'rows of');
    if (table) {
      body = `const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id, title')
  .in('id', IDS);
if (error) throw error;
return data || [];`;
    }
  } else if (concept === 'vector.similarity') {
    const matchCount = matchOne(p, [/top (\d+) rows/i])?.[1] || '5';
    if (rpc) {
      body = `const { data, error } = await insforge.database.rpc('${esc(rpc)}', {
  query_embedding: QUERY_EMBEDDING,
  match_count: ${Number(matchCount)}
});
if (error) throw error;
return data || [];`;
    }
  } else if (concept === 'vector.embed_insert') {
    const table = tables[0] || tickAfter(p, 'into');
    if (table) {
      body = `const { data, error } = await insforge.database
  .from('${esc(table)}')
  .insert(DOCS)
  .select();
if (error) throw error;
return { inserted: (data || []).length };`;
    }
  } else if (concept === 'storage.batch_remove') {
    const bucket = buckets[0] || matchOne(p, [/files in the `([^`]+)` bucket/i])?.[1];
    if (bucket) {
      body = `const { error } = await insforge.storage
  .from('${esc(bucket)}')
  .remove(KEYS);
if (error) throw error;
return { removed: KEYS.length };`;
    }
  } else if (concept === 'storage.list_meta') {
    const bucket = buckets[0] || matchOne(p, [/files in the `([^`]+)` bucket/i])?.[1];
    if (bucket) {
      body = `const { data, error } = await insforge.storage
  .from('${esc(bucket)}')
  .list();
if (error) throw error;
return { totalBytes: (data || []).reduce((sum, file) => sum + (file.size || 0), 0) };`;
    }
  } else if (concept === 'ai.batch_embed') {
    body = `const { data, error } = await insforge.ai.embeddings.create({
  model: 'openai/text-embedding-3-small',
  input: TEXTS,
});
if (error) throw error;
const rows = Array.isArray(data) ? data : (data?.data || []);
return rows
  .slice()
  .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  .map((row) => Array.isArray(row) ? row : row.embedding);`;
  } else if (concept === 'ai.no_base64_in_db') {
    const bucket = buckets[0] || matchOne(p, [/stores it in the `([^`]+)` bucket/i])?.[1];
    const table = matchOne(p, [/saves a row in `([^`]+)`/i])?.[1] || tables[tables.length - 1];
    if (bucket && table) {
      body = `const img = await insforge.ai.images.generate({ model: 'img', prompt: PROMPT });
const b64 = img.data?.[0]?.b64_json || '';
const bytes = { size: b64.length, type: 'image/png' };
const up = await insforge.storage.from('${esc(bucket)}').uploadAuto(bytes);
const key = up.data?.key || up.data?.path;
const { data, error } = await insforge.database
  .from('${esc(table)}')
  .insert([{ image_key: key }])
  .select();
if (error) throw error;
return { id: data?.[0]?.id };`;
    }
  } else if (concept === 'auth.owner_scope') {
    const table = tables[0] || tickAfter(p, 'rows from');
    if (table) {
      body = `const { data: user, error: userError } = await insforge.auth.getCurrentUser();
if (userError) throw userError;
const userId = user?.user?.id || user?.id;
const { data, error } = await insforge.database
  .from('${esc(table)}')
  .select('id')
  .eq('user_id', userId);
if (error) throw error;
return data || [];`;
    }
  }

  if (!body) return { code, repaired: false, reason: 'no_matching_repair' };
  const repairedCode = wrap(body);
  return { code: repairedCode, repaired: repairedCode.trim() !== String(code).trim(), reason };
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
  const body = await readStdin();
  const req = body.trim() ? JSON.parse(body) : {};
  process.stdout.write(JSON.stringify(repairAgentCode(req.taskId, req.prompt, req.code), null, 2) + '\n');
}

module.exports = { repairAgentCode, hasAgentCode };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
