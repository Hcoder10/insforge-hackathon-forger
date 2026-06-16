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
- `tools/forger.js`: project CLI for branch reviews, project reviews, and frontier artifact validation.

The current experiment ledger is in
[optimizer/docs/EXPERIMENTS.md](optimizer/docs/EXPERIMENTS.md). It lists what is already
proved, what is still running, and which artifacts support each claim.

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
- `Judge Mode`: branch review evidence, annotated merge SQL, project repair proof, frontier run status, and benchmark leaderboard.
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
npm run branch-pipeline
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

`npm run branch-pipeline` runs the full branch experiment matrix and writes
`bench/results/demo-recordings/branch-pipeline/pipeline.json`. The pipeline artifact rolls up
CPU, disk, memory, sequential scan, and timing deltas, then emits a promotion decision plus
the post-merge runtime deploy checklist for InsForge functions, frontend deployments, and
compute services.

## CI

GitHub Actions runs the judge evidence suite on every push and pull request:

```bash
npm run ci:judge
```

That command replays benchmark checks, recorded branch reviews, the project-review demo,
the branch experiment pipeline, the project-review demo, agent repair proof, project repair
proof, the repair audit, and frontier artifact validation.
The raw model frontier gate also runs in CI as an informational step, because the current raw
adapter is valid but does not yet beat the Codex baseline.

There is also a manual `branch-promotion` workflow for live InsForge backend branches. It
requires `INSFORGE_EMAIL`, `INSFORGE_PASSWORD`, `INSFORGE_PROJECT_ID`, and optionally
`INSFORGE_ORG_ID` as GitHub secrets. The workflow creates or uses a live branch, runs one
branch experiment, writes dry-run merge SQL, and only applies the merge when the dispatch
input `merge_after_review` is set to `true`.

## Project Review

Run a dry review on a generated InsForge app folder:

```bash
npm run project-review:demo
```

The command scans JavaScript and TypeScript source, applies the same SDK repair rules used
by the project benchmark, and writes a review report plus repaired copies under
`bench/results/demo-recordings/project-review-customer-portal/`. It does not modify the
project unless `--apply` is passed. Dry runs also write `forger.patch` and `pr-comment.md`
so the review can be applied or pasted into a pull request.

Use it on another project folder:

```bash
node tools/forger.js project-review --project path/to/insforge-app --out bench/results/demo-recordings/project-review-custom
```

## Frontier Optimizer Run

The GPU path for the optimizer is:

```bash
cd optimizer
FO_DATA_N=80 FO_MODEL_TAG=frontier bash scripts/frontier_run.sh
```

The live run writes `optimizer/results/frontier_run.json`. Judge Mode uses that file when it
exists, otherwise it shows the clearly marked recorded demo target. See
[optimizer/docs/FRONTIER_RUN.md](optimizer/docs/FRONTIER_RUN.md).

Modal GPU commands are available for the active weak-concept frontier run:

```bash
npm run modal:gpu-probe
FORGER_MODAL_TRAIN_GPU=H100 npm run modal:frontier
```

The probe artifact is `optimizer/results/modal_probe.json`. The H100 run writes to
`optimizer/results/modal-weakfix-h100/` when complete. The experiment configuration and
acceptance rule are tracked in
[optimizer/experiments/modal_weakfix_h100.json](optimizer/experiments/modal_weakfix_h100.json).

Latest audited raw GPU model run:

- Model: `forge-optimizer-frontier:frontier-plus-raw`
- Score: `83.3` on 39 sealed benchmark tasks
- Baseline shown in Judge Mode: `codex` at `87.2`
- Delta: `-3.9`
- Domains: database `91.7`, vector `100.0`, storage `66.7`, AI `50.0`, auth `100.0`

There is also a repair-layer audit artifact at
`optimizer/results/frontier_run.repair_assisted_live.json`. It scores `100.0`, but it is not
a model-only score: `npm run frontier-audit:repair` shows that the deterministic repair layer
can solve the sealed prompts even when the model output is empty. Treat that artifact as a
verifier result and distillation target, not as proof that the trained adapter beat the
frontier baseline.

A manual usefulness probe is documented in
[optimizer/docs/MODEL_USEFULNESS.md](optimizer/docs/MODEL_USEFULNESS.md). The short version:
the raw adapter is useful for database projections, pagination, storage metadata, and some
review comments. It is not reliable enough for autonomous repair on image, vector, and
multi-step SDK-shape cases.

## Agent Code Repair

The code-aware repair path is separate from the prompt-only repair audit. It requires real
agent code as input, extracts the InsForge table, bucket, or RPC target from that code, and
refuses empty submissions.

```bash
npm run agent-repair:bench
```

Current result over eight saved agent submissions (`codex`, `claude`, `gemini`, `gpt-oss`,
`nemotron`, `qwen3.6`, `devin`, and the raw forge-optimizer run):

- Average score before repair: `69.4`
- Average score after repair: `100.0`
- Fixed failures: `95`
- Regressions: `0`
- Empty-output guard: `0/39` repaired

FORGER also has a project-folder repair benchmark for generated InsForge app code:

```bash
npm run project-repair:bench
```

Current project repair result:

- Projects: `2`
- Cases: `5`
- Correct before repair: `3/5`
- Efficient before repair: `0/5`
- Correct after repair: `5/5`
- Efficient after repair: `5/5`
- Fixed correctness failures: `2`
- Fixed efficiency failures: `3`
- Regressions: `0`

The project repair benchmark copies full app folders, patches source files, and reruns
before/after tests against the InsForge SDK mock. It covers database pagination, insert
array form, current-user auth shape, storage metadata reads, and batch deletes. Add more
projects under `optimizer/fixtures/agent_projects/`, or pass a project fixture directory with
`node optimizer/eval/project_repair_benchmark.js --projects <dir>`.

Project review dry runs also produce an applyable patch:

```bash
npm run project-review:demo
git apply --directory optimizer/fixtures/agent_projects/insforge-customer-portal bench/results/demo-recordings/project-review-customer-portal/forger.patch
```

Run the repair proof suite:

```bash
npm run proof:repair
```

The raw model frontier gate is intentionally separate:

```bash
npm run frontier-gate:raw
```

That gate must pass before claiming the trained model itself beats Codex. It rejects
repair-labeled artifacts and currently fails on the latest raw run because `83.3` does not
beat the Codex baseline of `87.2`.

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
