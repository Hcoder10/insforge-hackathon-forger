// forger-bench — frontier CLI runner (headless). claude / gemini / codex.
//
// Drives a coding-agent CLI in non-interactive mode, one task at a time, with a byte-identical
// prompt, and extracts the solve() code from stdout. Each CLI has a different headless flag:
//   claude:  claude -p "<prompt>" --output-format text [--model <m>]
//   gemini:  gemini -p "<prompt>" [-m <model>] --approval-mode yolo
//   codex:   codex exec "<prompt>"   (prints the agent transcript; we extract the code block)
//
// The prompt is passed on stdin to avoid arg-length/quoting issues across the shell.
// usage: node runners/run_cli.js <claude|gemini|codex> <split> <outFile> [model]
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const tasks = require('../tasks');
const { buildFlatPrompt } = require('../bench/prompt');
const { extractCode } = require('../bench/extract');

// Build argv for a given CLI. The PROMPT ALWAYS goes on stdin (never argv) so the
// newline-heavy prompt can't be mangled by shell quoting / arg-length limits on Windows.
//   claude: `claude -p` reads the prompt from stdin when no prompt arg is given
//   gemini: `gemini` reads stdin in non-interactive mode (with -p "" it appends stdin)
//   codex:  `codex exec -` reads instructions from stdin
function cliArgs(cli, model) {
  switch (cli) {
    case 'claude':
      return ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])];
    case 'gemini':
      return ['--approval-mode', 'plan', ...(model ? ['-m', model] : [])];
    case 'codex':
      return ['exec', '--skip-git-repo-check', '-'];
    default:
      throw new Error(`unknown cli ${cli}`);
  }
}

function runOne(cli, prompt, model) {
  // shell:true is required on Windows to launch npm .cmd shims, but the PROMPT is fed via
  // stdin (never the shell), so only the static flags pass through the shell — safe.
  const r = spawnSync(cli, cliArgs(cli, model), {
    input: prompt, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (r.error) throw r.error;
  return (r.stdout || '') + '\n' + (r.stderr || '');
}

async function main() {
  const [cli, split = 'test', outFile, model] = process.argv.slice(2);
  if (!cli || !outFile) { console.error('usage: node runners/run_cli.js <claude|gemini|codex> <split> <outFile> [model]'); process.exit(1); }
  const list = split === 'train' ? tasks.TRAIN : split === 'all' ? tasks.ALL : tasks.TEST;
  console.log(`${cli}${model ? ' (' + model + ')' : ''} — ${list.length} ${split} tasks`);

  const solutions = {};
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const task = list[i];
    try {
      const raw = runOne(cli, buildFlatPrompt(task), model);
      const code = extractCode(raw);
      if (code) { solutions[task.id] = code; ok++; }
      process.stdout.write(`\r  [${i + 1}/${list.length}] ${task.id.padEnd(28)} ${code ? 'ok ' : 'NO-CODE'}   \n`);
    } catch (e) {
      process.stdout.write(`\r  [${i + 1}/${list.length}] ${task.id} ERROR ${String(e.message).slice(0, 50)}\n`);
    }
  }
  const sub = { model: `${cli}${model ? ':' + model : ''}`, meta: { runner: cli, split, extracted: ok, total: list.length }, solutions };
  fs.writeFileSync(outFile, JSON.stringify(sub, null, 2));
  console.log(`wrote ${outFile} — extracted code for ${ok}/${list.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
