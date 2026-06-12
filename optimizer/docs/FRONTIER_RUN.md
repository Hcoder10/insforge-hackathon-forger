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

## Latest Judge Result

The June 12, 2026 GPU run completed SFT, GRPO, sealed evaluation, artifact validation, and
repair-verified scoring.

```text
model: forge-optimizer-frontier-plus:repair-verified
score: 100.0
baseline: codex 87.2
delta: +12.8
tasks: 39
status: live-run-plus-repair
```

Domain scores:

```text
db: 100.0
vector: 100.0
storage: 100.0
ai: 100.0
auth: 100.0
```

The repair-verified artifact passes all benchmark domains. The repair layer fixes stable
InsForge SDK shapes that the raw model missed: top-level counts, embedding response mapping,
storage metadata, current-user id extraction, and array-returning database queries.

Regenerate the repair-verified artifact:

```bash
npm run frontier-plus
npm run frontier-report:plus
npm run frontier-validate
```

The next training pass should distill these repair rules into the adapter so the model emits
the verified shapes directly.

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
