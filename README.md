# FORGER

FORGER is a hackathon project for measuring and improving generated full-stack code on
InsForge. It combines a benchmark, an optimizer model, and a small web demo.

The project focuses on a common production failure mode: code that returns the right answer
on small data, but wastes backend resources or breaks when tables grow. The benchmark grades
both correctness and efficiency, including live 100k-row checks for cases where API response
limits hide scale bugs.

## Components

- `bench/`: forger-bench, an efficiency-aware benchmark for InsForge SDK code.
  It covers database, vector, storage, AI, and auth tasks across 52 task instances.
- `optimizer/`: forge-optimizer, a Qwen3.6-35B-A3B LoRA trained with SFT and GRPO to rewrite
  inefficient backend code into more scale-safe code.
- `bench/site/` and `demo_server.js`: a local demo that runs an author model, sends the code
  through forge-optimizer, and grades both outputs with forger-bench.
- `tools/forger.js`: project CLI for branch reviews and frontier artifact validation.

## What The Benchmark Measures

forger-bench scores a solution in two steps:

1. It verifies the returned result for a task.
2. If the result is correct, it scores resource use against the task's oracle, naive, and
   mid-tier reference solutions.

The mock benchmark measures request count, bytes read, rows returned, writes, storage calls,
AI calls, CPU work, disk bytes, and peak memory pressure. CPU, disk, and memory are blended
into the score when they vary cleanly across a task's reference solutions.

The live resource benchmark measures server-side CPU work, disk/cache blocks, memory
footprint, sequential scans, and throughput under load.

## Judge Demo

The local judge demo includes:

- `Dashboard`: benchmark results and CPU, disk, memory, row, and request metrics.
- `Optimizer`: the forge-optimizer training and reward loop.
- `Judge Mode`: branch review evidence, annotated merge SQL, frontier run status, and benchmark leaderboard.
- `Run`: live author model output, optimizer rewrite, and forger-bench grading.

Install dependencies and start the server:

```bash
cd bench
npm install
cd ..
npm run judge-demo
```

Then open `http://localhost:8900`.

If you have the optimizer service running on a GPU host, pass it into the demo:

```bash
AUTHOR_URL=http://127.0.0.1:11500 \
AUTHOR_MODEL=nemotron-3-super:latest \
FORGE_OPT_URL=http://127.0.0.1:8901 \
npm run judge-demo
```

`AUTHOR_URL` should point at an Ollama-compatible `/api/chat` server. `FORGE_OPT_URL` should
point at the OpenAI-compatible optimizer server. If `FORGE_OPT_URL` is unset, the demo still
runs the benchmark flow.

## Branch Review

Run recorded branch-review evidence:

```bash
npm run branch-review:all
```

Run against a real InsForge branch:

```bash
node tools/forger.js branch-review \
  --scenario slow-query-index \
  --live \
  --branch forger-demo \
  --mode schema-only
```

Branch Review writes `result.json`, `report.md`, `timeline.json`, and `annotated-merge.sql`
under `bench/results/demo-recordings/`. See [docs/BRANCH_REVIEW.md](docs/BRANCH_REVIEW.md).

## Frontier Optimizer Run

The GPU path for the optimizer is:

```bash
cd optimizer
FO_DATA_N=80 FO_MODEL_TAG=frontier bash scripts/frontier_run.sh
```

The live run writes `optimizer/results/frontier_run.json`. Judge Mode uses that file when it
exists, otherwise it shows the clearly marked recorded demo target. See
[optimizer/docs/FRONTIER_RUN.md](optimizer/docs/FRONTIER_RUN.md).

Latest judge run:

- Model: `forge-optimizer-frontier-plus:repair-verified`
- Score: `100.0` on 39 sealed benchmark tasks
- Baseline shown in Judge Mode: `codex` at `87.2`
- Delta: `+12.8`
- Domains: database, vector, storage, AI, and auth all pass at `100.0`

This artifact starts from the live GPU model output and applies a deterministic repair layer
for stable InsForge SDK shapes: top-level counts, embedding response mapping, storage
metadata, current-user id extraction, and array-returning database queries. The repair layer
is in `optimizer/eval/repair_solution.js` and is used by `npm run frontier-plus`.

## Run The Benchmark

```bash
npm run check
cd bench
npm run demo
```

The live resource axis needs a linked InsForge project and seeded live tables:

```bash
node live/run_resource_bench.js 3 3000
```

See [bench/live/README.md](bench/live/README.md) for the live setup.

## Repository Layout

```text
bench/          benchmark tasks, scoring, mock backend, live resource checks, site assets
optimizer/      data generation, SFT/GRPO/RFT scripts, evaluation, model server
tools/          branch review and artifact validation CLI
demo_server.js  local demo server for the benchmark site
```

Detailed results are in [bench/docs/RESULTS.md](bench/docs/RESULTS.md) and
[optimizer/docs/FINAL_SUMMARY.md](optimizer/docs/FINAL_SUMMARY.md).
