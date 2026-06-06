// forge-bench — 3-model resource benchmark wrapper (rate-limit-safe).
// Temporarily restricts the model set to codex/claude/qwen3.6 (top frontier + the base model),
// runs the resource benchmark at low concurrency with retry, then restores all submissions.
// Persistent background job (not a workflow agent), so it survives long backoff waits.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RESULTS = path.join(__dirname, '..', 'results');
const KEEP = new Set(['sub_codex.json', 'sub_claude.json', 'sub_qwen3.6.json']);
const PARK = path.join(RESULTS, '_parked3');

function park() {
  fs.mkdirSync(PARK, { recursive: true });
  for (const f of fs.readdirSync(RESULTS)) {
    if (f.startsWith('sub_') && f.endsWith('.json') && !KEEP.has(f)) {
      fs.renameSync(path.join(RESULTS, f), path.join(PARK, f));
    }
  }
}
function restore() {
  if (!fs.existsSync(PARK)) return;
  for (const f of fs.readdirSync(PARK)) fs.renameSync(path.join(PARK, f), path.join(RESULTS, f));
  fs.rmdirSync(PARK);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  park();
  try {
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      console.log(`[bench3] attempt ${attempt} @ ${new Date().toISOString().slice(11, 19)}`);
      const r = spawnSync('node', [path.join(__dirname, 'run_resource_bench.js'), '3', '3000'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 40 * 60 * 1000,
      });
      const out = (r.stdout || '') + (r.stderr || '');
      fs.writeFileSync(path.join(RESULTS, 'resource_run3.log'), out);
      if (/RESOURCE LEADERBOARD/.test(out) && !/Too many requests|429/.test(out.split('RESOURCE LEADERBOARD')[1] || '')) {
        ok = true; console.log('[bench3] completed'); console.log(out.split('\n').slice(-14).join('\n'));
      } else {
        console.log(`[bench3] hit limit/incomplete; waiting 180s before retry`);
        await sleep(180000);
      }
    }
    if (!ok) console.log('[bench3] did not complete cleanly after retries; see resource_run3.log');
  } finally {
    restore();
    console.log('[bench3] restored parked submissions');
  }
}

main();
