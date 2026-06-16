# Three Minute Judge Demo

Goal: show FORGER as a daily workflow for InsForge teams: benchmark generated code, catch resource regressions in backend branches, and use forge-optimizer in PR review.

## Before Recording

Open these windows:

1. Browser tab: `http://localhost:8900`
2. Browser tab: the GitHub PR with the `FORGER PR Guard` comment
3. Browser tab: `https://huggingface.co/squaredcuber/forge-optimizer-qwen3.6-35b-a3b`
4. Terminal in `C:\Users\sarta\insforge-hackathon-forger`
5. Optional terminal in `C:\Users\sarta\smooth-motion-packages`

Start the demo server:

```bash
npm run judge-demo
```

If the optimizer is still served on the Tailscale GPU, keep this endpoint handy:

```bash
FORGE_OPT_URL=http://100.79.153.43:8901
```

## Script

### 0:00 to 0:20, Problem

Open `http://localhost:8900` on the Dashboard.

Say:

> FORGER is a benchmark and review system for generated InsForge apps. The failure mode we target is code that works on small data, but wastes requests, rows, storage downloads, CPU, memory, or disk as the project grows.

Point at the metric cards. Mention correctness first, then resource use.

### 0:20 to 0:55, Benchmark

Open the benchmark or leaderboard section in the judge demo.

Show:

- Correctness gated score
- Request count and bytes read
- Rows returned
- CPU work
- Disk bytes
- Peak memory pressure
- Storage calls and AI calls

Say:

> The benchmark checks correctness first, then measures whether the generated code uses the InsForge SDK in a production-shaped way. Resource use determines the score after the answer is correct.

In terminal, run:

```bash
npm run check
```

If time is tight, do not wait on the full output. Show that this is the repeatable benchmark command.

### 0:55 to 1:35, Branch Review

Open Judge Mode, Branch Review, or the recorded branch pipeline artifact.

In terminal, run:

```bash
npm run branch-pipeline
```

Show `bench/results/demo-recordings/branch-pipeline/pipeline.json` or the UI summary.

Say:

> This is the daily InsForge workflow. A backend branch proposes a change. FORGER compares the branch against baseline behavior and records CPU, memory, disk, sequential scan, and timing deltas before promotion.

Show one recorded report, for example:

```text
bench/results/demo-recordings/branch-review-slow-query-index/report.md
bench/results/demo-recordings/branch-review-pagination-scale/report.md
bench/results/demo-recordings/branch-review-storage-metadata/report.md
```

### 1:35 to 2:15, PR Guard and Project Review

Open the GitHub PR with the `FORGER PR Guard` comment.

Say:

> FORGER also works at the pull request level. It scans generated app code for concrete InsForge SDK mistakes: insert shape, auth response handling, overfetching, pagination, storage downloads, and batch deletes.

In terminal, run:

```bash
npm run project-review:demo
```

Then show:

```text
bench/results/demo-recordings/project-review-customer-portal/pr-comment.md
bench/results/demo-recordings/project-review-customer-portal/forger.patch
```

Point out that it writes an applicable patch and a PR-ready comment.

### 2:15 to 2:45, forge-optimizer

Open the Hugging Face model page:

```text
https://huggingface.co/squaredcuber/forge-optimizer-qwen3.6-35b-a3b
```

Then show the model-assisted project review artifact from the dogfood app:

```text
C:\Users\sarta\smooth-motion-packages\forger-results\model-review\project-review.json
```

Say:

> forge-optimizer is the specialized model layer. In the PR flow, it is used as an advisory reviewer through an OpenAI-compatible endpoint. The deterministic verifier still applies and checks the concrete patch, so the workflow stays auditable.

Show these fields:

```json
"mode": "model-assisted"
"attempted": 2
"findings": 3
"failed": 0
```

### 2:45 to 3:00, Close

Return to the Dashboard or Judge Mode summary.

Say:

> The result is a judgeable workflow: benchmark tasks in the repo, branch promotion evidence, PR comments, applicable patches, and a served optimizer model. The narrow claim is practical: FORGER helps InsForge users catch correctness and resource problems before they ship generated backend code.

## Benchmarks To Show

Show these if asked for proof:

- `npm run check`: mock benchmark validation, calibration, verification, and contamination checks.
- `npm run branch-pipeline`: recorded branch reviews with CPU, disk, memory, sequential scan, and timing metrics.
- `npm run project-review:demo`: project-level SDK repair evidence and PR comment output.
- `npm run proof:repair`: agent repair benchmark, project repair benchmark, and repair-layer audit.
- `optimizer/results/frontier_run.json`: raw model score, currently close to but below the Codex baseline.
- `optimizer/results/frontier_run.repair_assisted_live.json`: repair-layer verified score, explicitly not a model-only result.

## Claims To Avoid

- Do not claim the raw adapter beats Codex on arbitrary code repair.
- Do not present the repair-layer `100.0` score as a model-only benchmark.
- Do not claim full-file autonomous rewrites are production-ready. The current reliable workflow is model-assisted review plus verified patch generation.
