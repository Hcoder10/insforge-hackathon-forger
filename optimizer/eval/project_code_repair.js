#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

function walkFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file));
    else if (SOURCE_EXTS.has(path.extname(entry.name))) out.push(file);
  }
  return out;
}

function escRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceInsertObjectArgs(source) {
  let out = '';
  let cursor = 0;
  const repairs = [];
  const token = '.insert(';

  while (true) {
    const start = source.indexOf(token, cursor);
    if (start === -1) break;
    const argStart = start + token.length;
    const argEnd = findMatchingParen(source, argStart - 1);
    if (argEnd === -1) break;

    const arg = source.slice(argStart, argEnd);
    const trimmed = arg.trim();
    out += source.slice(cursor, argStart);
    if (trimmed && !trimmed.startsWith('[')) {
      out += `[${arg}]`;
      repairs.push('database.insert-array-form');
    } else {
      out += arg;
    }
    cursor = argEnd;
  }

  out += source.slice(cursor);
  return { source: out, repairs };
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function repairAuthCurrentUser(source) {
  const repairs = [];
  const out = source.replace(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+insforge\.auth\.getCurrentUser\(\);/g,
    (m, userVar) => {
      repairs.push('auth.get-current-user-shape');
      return `const { data: ${userVar}AuthData, error: ${userVar}AuthError } = await insforge.auth.getCurrentUser();
  if (${userVar}AuthError) throw ${userVar}AuthError;
  const ${userVar} = ${userVar}AuthData?.user || ${userVar}AuthData;`;
    },
  );
  return { source: out, repairs };
}

function repairStorageMetadataLoop(source) {
  const listMatch = source.match(/const\s+\{\s*data:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*await\s+insforge\.storage\.from\(['"]([^'"]+)['"]\)\.list\(\);/);
  if (!listMatch || !/let\s+totalBytes\s*=\s*0\s*;/.test(source)) return { source, repairs: [] };

  const filesVar = listMatch[1];
  const loopRe = new RegExp(
    `for\\s*\\(\\s*const\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${escRe(filesVar)}\\s*\\)\\s*\\{[\\s\\S]*?\\.download\\(\\s*\\1\\.key\\s*\\)[\\s\\S]*?totalBytes\\s*\\+=\\s*[^;]+;\\s*\\}`,
    'm',
  );
  if (!loopRe.test(source)) return { source, repairs: [] };
  return {
    source: source.replace(loopRe, `totalBytes = (${filesVar} || []).reduce((sum, file) => sum + (file.size || 0), 0);`),
    repairs: ['storage.metadata-without-download'],
  };
}

function repairStorageBatchRemove(source) {
  const loopRe = /let\s+removed\s*=\s*0\s*;\s*for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{\s*await\s+insforge\.storage\.from\(['"]([^'"]+)['"]\)\.remove\(\s*\1\s*\);\s*removed\s*\+=\s*1\s*;\s*\}/m;
  const m = source.match(loopRe);
  if (!m) return { source, repairs: [] };
  return {
    source: source.replace(loopRe, `const { error: removeError } = await insforge.storage.from('${m[3]}').remove(${m[2]});
  if (removeError) throw removeError;
  const removed = ${m[2]}.length;`),
    repairs: ['storage.batch-remove'],
  };
}

function repairPaginationCountProjection(source) {
  const queryRe = /const\s+\{\s*data\s*\}\s*=\s*await\s+insforge\.database\s*\n?\s*\.from\(['"]([^'"]+)['"]\)\s*\n?\s*\.select\(['"]\*['"]\)\s*\n?\s*\.order\(['"]created_at['"],\s*\{\s*ascending:\s*false\s*\}\)\s*\n?\s*\.range\((\d+),\s*(\d+)\);/m;
  const m = source.match(queryRe);
  if (!m) return { source, repairs: [] };

  const table = m[1];
  const projection = inferProjection(source);
  if (!projection) return { source, repairs: [] };

  let out = source.replace(queryRe, `const { data, count, error } = await insforge.database
    .from('${table}')
    .select('${projection}', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(${m[2]}, ${m[3]});
  if (error) throw error;`);

  const countRowsRe = new RegExp(
    `\\s*const\\s+\\{\\s*data:\\s*countRows\\s*\\}\\s*=\\s*await\\s+insforge\\.database\\s*\\n?\\s*\\.from\\(['"]${escRe(table)}['"]\\)\\s*\\n?\\s*\\.select\\(['"]id['"]\\);`,
    'm',
  );
  out = out.replace(countRowsRe, '');
  out = out.replace(/total:\s*countRows\.length/g, 'total: count');
  return { source: out, repairs: ['database.pagination-count-projection'] };
}

function inferProjection(source) {
  const destructured = source.match(/map\(\s*\(\{\s*id\s*,\s*([A-Za-z_$][\w$]*)\s*\}\)\s*=>\s*\(\{\s*id\s*,\s*\1\s*\}\)\s*\)/);
  if (destructured) return `id, ${destructured[1]}`;
  const object = source.match(/map\(\s*\w+\s*=>\s*\(\{\s*id:\s*\w+\.id\s*,\s*([A-Za-z_$][\w$]*):\s*\w+\.\1\s*\}\)\s*\)/);
  if (object) return `id, ${object[1]}`;
  return null;
}

function repairSource(source) {
  const allRepairs = [];
  let current = source;
  for (const repair of [
    replaceInsertObjectArgs,
    repairAuthCurrentUser,
    repairStorageMetadataLoop,
    repairStorageBatchRemove,
    repairPaginationCountProjection,
  ]) {
    const out = repair(current);
    current = out.source;
    allRepairs.push(...out.repairs);
  }
  return { source: current, repairs: allRepairs };
}

function repairProject(root) {
  const files = [];
  for (const file of walkFiles(root)) {
    const before = fs.readFileSync(file, 'utf8');
    const out = repairSource(before);
    if (!out.repairs.length || out.source === before) continue;
    fs.writeFileSync(file, out.source);
    files.push({
      file: path.relative(root, file).split(path.sep).join('/'),
      repairs: out.repairs,
    });
  }
  return { files, repairCount: files.reduce((sum, f) => sum + f.repairs.length, 0) };
}

module.exports = { repairSource, repairProject };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const out = repairProject(root);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
