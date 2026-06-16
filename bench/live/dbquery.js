// forger-bench - run SQL on the live InsForge backend via the CLI, returning parsed JSON.
// Stages SQL in a temp file and feeds it through bash `"$(cat file)"` command substitution
// (the quoting path proven to work for db query; the CLI has no --file flag and shell-arg
// quoting mangles parens/quotes in the SQL).
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _n = 0;
function bashPath(file) {
  const normalized = file.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/${match[1].toLowerCase()}/${match[2]}`;
}

function sleepSync(ms) {
  // synchronous sleep via Atomics so retry backoff works in this sync helper
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function dbQuery(sql, { retries = 4 } = {}) {
  const f = path.join(os.tmpdir(), `fb_q_${process.pid}_${_n++}_${Math.floor(Math.random() * 1e9)}.sql`);
  fs.writeFileSync(f, sql, 'utf8');
  const posix = bashPath(f);
  try {
    for (let attempt = 0; ; attempt++) {
      const r = process.platform === 'win32'
        ? spawnSync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$sql = Get-Content -Raw -LiteralPath ${JSON.stringify(f)}; npx --yes @insforge/cli db query $sql --json`,
        ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
        : spawnSync('bash', ['-c', `npx --yes @insforge/cli db query "$(cat '${posix}')" --json`], {
          encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
        });
      if (r.error) throw r.error;
      const out = r.stdout || '';
      const start = out.indexOf('{');
      if (start !== -1) {
        const j = JSON.parse(out.slice(start));
        // retry on rate limit / transient OSS errors
        if (j.error && /429|rate|timeout|temporarily/i.test(JSON.stringify(j.error)) && attempt < retries) {
          sleepSync(1000 * (attempt + 1)); continue;
        }
        return j;
      }
      const blob = (out + (r.stderr || ''));
      if (/429|rate|timeout/i.test(blob) && attempt < retries) { sleepSync(1000 * (attempt + 1)); continue; }
      throw new Error('no JSON from db query: ' + blob.slice(0, 200));
    }
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
}

module.exports = { dbQuery };
