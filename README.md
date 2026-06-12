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

## What The Benchmark Measures

forger-bench scores a solution in two steps:

1. It verifies the returned result for a task.
2. If the result is correct, it scores resource use against the task's oracle, naive, and
   mid-tier reference solutions.

The mock benchmark measures request count, bytes read, rows returned, writes, storage calls,
and AI calls. The live resource benchmark can also measure server-side work such as rows
scanned, buffers touched, sequential scans, and throughput under load.

## Run The Demo

Install the benchmark dependencies:

```bash
cd bench
npm install
cd ..
```

Start the optimizer service on a GPU host if you want live rewrites:

```bash
cd optimizer
python serve_model.py
```

Start the demo server:

```bash
AUTHOR_URL=http://127.0.0.1:11500 \
AUTHOR_MODEL=nemotron-3-super:latest \
FORGE_OPT_URL=http://127.0.0.1:8901 \
node demo_server.js 8900
```

Then open `http://localhost:8900`.

`AUTHOR_URL` should point at an Ollama-compatible `/api/chat` server. `FORGE_OPT_URL` should
point at the OpenAI-compatible optimizer server. If `FORGE_OPT_URL` is unset, the demo skips
the rewrite step and still runs the benchmark flow.

## Run The Benchmark

```bash
cd bench
npm run check
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
demo_server.js  local demo server for the benchmark site
```

Detailed results are in [bench/docs/RESULTS.md](bench/docs/RESULTS.md) and
[optimizer/docs/FINAL_SUMMARY.md](optimizer/docs/FINAL_SUMMARY.md).
