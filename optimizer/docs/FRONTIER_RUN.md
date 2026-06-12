# Frontier Optimizer Run

The frontier run is the GPU path for producing a judge-ready forge-optimizer artifact. It trains the latest optimizer adapter, evaluates it on forger-bench, then writes a normalized report consumed by Judge Mode.

## GPU Run

From the repo root:

```bash
cd optimizer
FO_DATA_N=80 FO_MODEL_TAG=frontier bash scripts/frontier_run.sh
```

The script runs:

1. Data generation and contamination check.
2. SFT training.
3. GRPO training.
4. Sealed benchmark evaluation.
5. Frontier report generation.
6. Artifact validation.

The final live artifact is:

```text
optimizer/results/frontier_run.json
```

Judge Mode prefers that file. If it is missing, it falls back to:

```text
optimizer/results/frontier_run.recorded.json
```

The recorded file is a demo target, not a replacement for the GPU result.

## Latest Live Result

The June 12, 2026 GPU run completed SFT, GRPO, sealed evaluation, and artifact validation.

```text
model: forge-optimizer-frontier:frontier
score: 53.8
baseline: codex 87.2
tasks: 39
status: live-run
```

Domain scores:

```text
db: 50.0
vector: 100.0
storage: 100.0
ai: 0.0
auth: 0.0
```

The result is useful evidence because it is a full live GPU run with CPU, disk, memory, wall
time, CPU time, and peak RSS metrics. It is not yet the frontier-beating result. The next
tuning pass should focus on AI and auth tasks, then recover DB pagination and projection.

## Manual Report Generation

If you already have a score file:

```bash
node optimizer/eval/frontier_report.js \
  --score bench/results/score_fo-frontier.json \
  --baseline bench/results/score_codex.json \
  --out optimizer/results/frontier_run.json \
  --model forge-optimizer-frontier:qwen3.6
```

Validate the artifact:

```bash
node tools/forger.js frontier-validate --file optimizer/results/frontier_run.json
```

## Next Acceptance Bar

For the next judge demo pass, the live optimizer artifact should show:

- Higher mean score than the current best frontier baseline in `bench/results/leaderboard.json`.
- No drop in pass rate on sealed tasks.
- Better CPU, disk, and memory resource means on scale-sensitive tasks.
- Clean contamination check output.
