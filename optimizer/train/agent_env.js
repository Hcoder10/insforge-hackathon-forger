// forge-optimizer — agentic environment (CUDA-Agent style, for backend code).
//
// Their loop: implement -> compile -> verify -> profile -> iterate, with the measured signal
// fed back each turn. Ours: implement -> RUN (mock or live) -> verify correctness (incl. the
// 100k-row scaleBug trap) -> measure server cost -> feed back -> iterate.
//
// This file is the GRADER/ENV the Python trainer calls (one task+code -> structured
// observation + milestone reward). Kept in Node because the forger-bench grader is JS.
//
//   echo '{"taskId":"...","code":"..."}' | node train/agent_env.js
//   -> {"correct":bool,"scaleBug":bool,"reward":-1|1|2|3,"score":num,"obs":"<feedback text>"}
//
// Reward = CUDA-Agent discrete milestone scheme (their top ablation):
//   -1 incorrect or scaleBug ; 1 correct/wasteful ; 2 correct+beats-naive ; 3 oracle-class.

'use strict';

const path = require('path');
const FB = process.env.FO_FORGER_BENCH || path.join(__dirname, '..', '..', 'bench');
const tasks = require(path.join(FB, 'tasks'));
const { gradeSolution } = require(path.join(FB, 'bench', 'harness'));

// Milestone reward from a graded record + the task's oracle/naive cost anchors.
function milestone(graded) {
  if (!graded.correct) return -1;           // wrong (the harness verify failed)
  // graded.eff in [0,1] is the request-cost efficiency vs the task's own spread.
  // (When the agentic loop runs against live, scaleBug folds into !correct upstream.)
  if (graded.eff >= 0.95) return 3;         // oracle-class
  if (graded.eff >= 0.30) return 2;         // beats the naive meaningfully
  return 1;                                 // correct but wasteful
}

// Build the natural-language observation fed back to the model next turn (CUDA-Agent feeds
// compiler/test/profile output; we feed correctness + the cost breakdown + a hint).
function observation(graded) {
  if (graded.error) return `Runtime error: ${graded.error}. Fix the code so it runs.`;
  if (!graded.correct) {
    return `INCORRECT: the solution ran but returned the wrong result. Re-read the task; at `
      + `100k rows, fetching all rows then processing in JS returns wrong results (the API `
      + `caps responses at 1000 rows). Do counting/filtering/pagination on the server.`;
  }
  const m = graded.metrics || {};
  const parts = [];
  if (graded.perMetric) for (const [k, p] of Object.entries(graded.perMetric)) {
    parts.push(`${k}: ${(p * 100).toFixed(0)}% optimal`);
  }
  const verdict = graded.eff >= 0.95 ? 'Near-optimal — excellent.'
    : graded.eff >= 0.30 ? 'Correct and better than naive, but more efficiency is possible.'
    : 'Correct but wasteful — minimize round-trips, bytes, and rows scanned.';
  return `CORRECT. Efficiency ${(graded.eff * 100).toFixed(0)}% [${parts.join(', ')}]. ${verdict} `
    + `(dbOps=${m.dbOps}, bytesRead=${m.bytesRead}, rowsReturned=${m.rowsReturned})`;
}

async function step(taskId, code) {
  const task = tasks.get(taskId);
  if (!task) return { error: `unknown task ${taskId}`, reward: -1, correct: false };
  const graded = await gradeSolution(task, code);
  const reward = milestone(graded);
  return {
    taskId, correct: graded.correct, reward,
    score: graded.score, eff: graded.eff,
    obs: observation(graded),
    metrics: graded.metrics, error: graded.error || null,
  };
}

// CLI: read {taskId, code} from stdin, print one JSON line.
async function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) buf += c;
  const { taskId, code } = JSON.parse(buf);
  const out = await step(taskId, code);
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e.message), reward: -1, correct: false })); });
module.exports = { step, milestone, observation };
