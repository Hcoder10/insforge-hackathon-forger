// forge-optimizer — persistent grader worker (NDJSON over stdin/stdout).
//
// GRPO's reward calls this ONCE per process (not per completion), eliminating the
// per-grade Node startup + forger-bench require + cost-spread rebuild (code review M3).
// The per-task cost spread (oracle/naive/mid bounds) is computed once and CACHED, so each
// grade after the first for a task is just: run the candidate + percentile vs cached bounds.
//
// Protocol: read one JSON request per line {id, taskId, code} -> write one JSON line
// {id, reward, correct, eff, score}. Milestone reward (-1/1/2/3), same as agent_env.js.

'use strict';

const path = require('path');
const readline = require('readline');
const FB = process.env.FO_FORGER_BENCH || path.join(__dirname, '..', '..', 'bench');
const tasks = require(path.join(FB, 'tasks'));
const { gradeSolution } = require(path.join(FB, 'bench', 'harness'));

function milestone(g) {
  if (!g.correct) return -1;
  if (g.eff >= 0.95) return 3;
  if (g.eff >= 0.30) return 2;
  return 1;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, taskId, code } = req;
  const task = tasks.get(taskId);
  if (!task || !code) { process.stdout.write(JSON.stringify({ id, reward: -1, correct: false }) + '\n'); return; }
  try {
    const g = await gradeSolution(task, code);   // harness caches nothing, but one process amortizes require/JIT
    process.stdout.write(JSON.stringify({ id, reward: milestone(g), correct: g.correct, eff: g.eff, score: g.score }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, reward: -1, correct: false, error: String(e.message).slice(0, 120) }) + '\n');
  }
});
