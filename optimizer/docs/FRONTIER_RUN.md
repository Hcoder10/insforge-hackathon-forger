# Frontier Optimizer Run

The frontier run is the GPU path for producing a judge-ready forge-optimizer artifact. It trains the latest optimizer adapter, evaluates it on forger-bench, then writes a normalized report consumed by Judge Mode.

## GPU Run

From the repo root:

```bash
cd optimizer
FO_DATA_N=80 FO_MODEL_TAG=frontier bash scripts/frontier_run.sh
```

Run the repair-verified path with:

```bash
cd optimizer
FO_DATA_N=80 FO_MODEL_TAG=frontier-plus-distill FO_REPAIR=1 bash scripts/frontier_run.sh
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

## Latest Audited Result

The June 13, 2026 GPU run completed SFT, GRPO, sealed evaluation, and artifact validation.
The raw model output is the score to report as model performance.

```text
model: forge-optimizer-frontier:frontier-plus-raw
score: 83.3
baseline: codex 87.2
delta: -3.9
tasks: 39
status: live-run-raw
```

Domain scores:

```text
db: 91.7
vector: 100.0
storage: 66.7
ai: 50.0
auth: 100.0
```

The raw run does not beat the Codex baseline yet. The remaining failures are concentrated in
storage metadata handling and AI image storage tasks.

The repair-assisted live artifact is tracked separately at
`optimizer/results/frontier_run.repair_assisted_live.json`. It passes all benchmark domains,
but it should not be reported as a model-only score. The repair layer fixes stable InsForge
SDK shapes that the raw model missed: top-level counts, embedding response mapping, storage
metadata, current-user id extraction, and array-returning database queries.

Regenerate the repair-verified artifact:

```bash
npm run frontier-plus
npm run frontier-report:plus
node tools/forger.js frontier-validate --file optimizer/results/frontier_run.repair_assisted_live.json
```

Audit whether the repair layer is solving the benchmark without model output:

```bash
npm run frontier-audit:repair
```

Current audit result:

```text
REPAIR_LAYER_CAN_SOLVE_SEALED_TASKS_WITHOUT_MODEL_OUTPUT
score: 100.0
```

The next training pass should distill these repair rules into the adapter so the model emits
the verified shapes directly.

## Agent-Code Repair Proof

The prompt-only repair layer is useful as a prototype, but it is not enough evidence. The
code-aware repair benchmark uses saved outputs from other agents, requires non-empty
InsForge SDK code, extracts identifiers from that code, and refuses empty submissions.

```bash
npm run agent-repair:bench
```

Current artifact: `optimizer/results/agent_repair_benchmark.json`.

```text
models: 8
averageBefore: 69.4
averageAfter: 100.0
fixedFailures: 95
regressions: 0
emptyGuard: 0/39 repaired
```

This is the current proof that FORGER can repair generated code from other agents on the
benchmark suite.

The project-folder repair benchmark applies repairs inside complete generated InsForge app
folders, then reruns before/after tests:

```bash
npm run project-repair:bench
```

Current artifact: `optimizer/results/project_repair_benchmark.json`.

```text
projects: 2
cases: 5
beforeCorrect: 3
beforeEfficient: 0
afterCorrect: 5
afterEfficient: 5
fixedCorrectness: 2
fixedEfficiency: 3
regressions: 0
```

Run the full repair proof suite:

```bash
npm run proof:repair
```

## Raw Model Gate

Use this before claiming the trained adapter beats the frontier baseline:

```bash
npm run frontier-gate:raw
```

The gate rejects repair-labeled artifacts and requires the raw score in
`optimizer/results/frontier_run.json` to beat `baselineScore`.

## Manual Report Generation

If you already have a score file:

```bash
node optimizer/eval/frontier_report.js \
  --score bench/results/score_fo-frontier-plus-raw.json \
  --baseline bench/results/score_codex.json \
  --out optimizer/results/frontier_run.json \
  --model forge-optimizer-frontier:frontier-plus-raw \
  --status live-run-raw
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
