// forger-bench — Ollama runner. Generates a submission from an Ollama model.
//
// Models live on SquaredCube; point at it over Tailscale (default) or set OLLAMA_HOST.
// usage: node runners/run_ollama.js <model> <split> <outFile>
//   e.g. node runners/run_ollama.js gpt-oss:120b test results/sub_gpt-oss-120b.json
'use strict';

const fs = require('fs');
const tasks = require('../tasks');
const { buildMessages } = require('../bench/prompt');
const { extractCode } = require('../bench/extract');

// Default: SSH tunnel to SquaredCube's ollama (it binds 127.0.0.1 there; we forward
// laptop:11500 -> squaredcube:11434 to avoid colliding with the laptop's own ollama).
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11500';

async function generate(model, messages) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: false,
      think: false,                                  // disable thinking for clean code output
      options: { temperature: 0, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.message?.content || '';
}

async function main() {
  const [model, split = 'test', outFile] = process.argv.slice(2);
  if (!model || !outFile) { console.error('usage: node runners/run_ollama.js <model> <split> <outFile>'); process.exit(1); }
  const list = split === 'train' ? tasks.TRAIN : split === 'all' ? tasks.ALL : tasks.TEST;
  console.log(`ollama ${model} @ ${HOST} — ${list.length} ${split} tasks`);

  const solutions = {};
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const task = list[i];
    try {
      const raw = await generate(model, buildMessages(task));
      const code = extractCode(raw);
      if (code) { solutions[task.id] = code; ok++; }
      process.stdout.write(`\r  [${i + 1}/${list.length}] ${task.id.padEnd(28)} ${code ? 'ok ' : 'NO-CODE'}   `);
    } catch (e) {
      process.stdout.write(`\r  [${i + 1}/${list.length}] ${task.id} ERROR ${String(e.message).slice(0, 40)}\n`);
    }
  }
  console.log('');
  const sub = { model, meta: { runner: 'ollama', host: HOST, split, extracted: ok, total: list.length }, solutions };
  fs.writeFileSync(outFile, JSON.stringify(sub, null, 2));
  console.log(`wrote ${outFile} — extracted code for ${ok}/${list.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
