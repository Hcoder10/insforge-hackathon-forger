// forger-bench — self-contained resource-benchmark orchestrator.
// 1. Sleep to let the management-API rate limit cool (no polling — polling keeps it hot).
// 2. Install the fb_table_stats RPC (one management-API call).
// 3. Run the full resource benchmark via run_resource_bench (stats now go through the SDK
//    data plane, so no management-API pressure during the load test).
// Designed to run unattended in the background and self-complete.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { dbQuery } = require('./dbquery');

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForApi(maxMin = 20) {
  for (let i = 0; i < maxMin; i++) {
    await sleep(60000);                              // wait a full minute between probes
    try { dbQuery('SELECT 1 AS ok', { retries: 0 }); log(`API recovered after ~${i + 1} min`); return true; }
    catch { log(`still rate-limited (${i + 1} min)`); }
  }
  return false;
}

async function main() {
  log('cooling down rate limit (initial 120s, no polling)...');
  await sleep(120000);
  const ok = await waitForApi(20);
  if (!ok) { log('API did not recover in 20 min; aborting'); process.exit(1); }

  log('installing fb_table_stats RPC...');
  const sql = fs.readFileSync(path.join(__dirname, 'install_stats_rpc.sql'), 'utf8').trim();
  dbQuery(sql);
  // sanity: call it via management API once
  const t = dbQuery("SELECT fb_table_stats('articles') AS s");
  log('RPC installed; articles stats: ' + JSON.stringify(t.rows[0]).slice(0, 120));

  log('running resource benchmark (concurrency 4, 4s/solution, stats via data-plane RPC)...');
  const r = spawnSync('node', [path.join(__dirname, 'run_resource_bench.js'), '4', '4000'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000,
  });
  fs.writeFileSync(path.join(__dirname, '..', 'results', 'resource_run.log'), (r.stdout || '') + '\n' + (r.stderr || ''));
  log('benchmark finished; tail:');
  console.log((r.stdout || '').split('\n').slice(-20).join('\n'));
}

main().catch((e) => { console.error('AUTO_ERR', e); process.exit(1); });
