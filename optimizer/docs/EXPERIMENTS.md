# Experiments

This file is the judge-facing ledger for benchmark, branch review, project repair, and GPU
training work. It separates completed evidence from active experiments so the demo does not
overstate the raw model result.

## Completed Evidence

| Area | Command | Artifact | Current result |
| --- | --- | --- | --- |
| Benchmark correctness and resource scoring | `npm run check` | `bench/results/` | Passes mock smoke, calibration, verification, and contamination checks |
| Branch review | `npm run branch-review:all` | `bench/results/demo-recordings/branch-review-*` | Three recorded InsForge branch reviews with annotated merge SQL |
| Branch CI/CD pipeline | `npm run branch-pipeline` | `bench/results/demo-recordings/branch-pipeline` | Promotion gate, resource rollup, and post-merge runtime checklist |
| PR Guard CI/CD | `.github/workflows/ci.yml` | GitHub job summary, `forger-ci-evidence`, PR comment | Posts or updates a `FORGER PR Guard` comment on pull requests |
| Project review | `npm run project-review:demo` | `bench/results/demo-recordings/project-review-customer-portal` | Scans a generated InsForge app folder and emits repaired copies, `forger.patch`, and `pr-comment.md` |
| Agent repair proof | `npm run agent-repair:bench` | `optimizer/results/agent_repair_benchmark.json` | Agent submissions improve from 69.4 average to 100.0 after repair |
| Project repair proof | `npm run project-repair:bench` | `optimizer/results/project_repair_benchmark.json` | 5/5 project cases correct and efficient after repair |
| Repair audit | `npm run frontier-audit:repair` | `optimizer/results/frontier_run.repair_assisted_live.json` | 100.0 repair-assisted verifier result |
| Raw frontier validation | `npm run frontier-validate` | `optimizer/results/frontier_run.json` | Latest raw adapter artifact is valid |

## Raw Model Frontier Status

Latest audited raw GPU run:

- Model: `forge-optimizer-frontier:frontier-plus-raw`
- Score: `83.3`
- Codex baseline shown in Judge Mode: `87.2`
- Delta: `-3.9`
- Status: valid artifact, but not a raw model win

The repair-assisted artifact scores `100.0`, but that result includes deterministic verifier
repair. It is useful as a proof target and a distillation target. It is not a claim that the
trained adapter beat Codex by itself.

## Modal GPU Experiment

The active GPU experiment is tracked in
`optimizer/experiments/modal_weakfix_h100.json`.

Goal:

- Train a new raw adapter on the weakest sealed concepts from the latest raw run.
- Keep the repair layer disabled for the frontier claim.
- Accept the run only if `npm run frontier-gate:raw` passes against the completed artifact.

Data change:

- Add extra SFT examples for `count_only`, `list_meta`, and `no_base64_in_db`.
- Add extra GRPO sampling for the same concepts.
- Keep held-out concepts `top_n` and `in_list` excluded from training.

Runnable commands:

```bash
npm run modal:gpu-probe
FORGER_MODAL_TRAIN_GPU=H100 npm run modal:frontier
FORGER_MODAL_TRAIN_GPU=H100 npm run modal:frontier-fast
```

GPU proof:

- `optimizer/results/modal_probe.json` records a successful Modal L40S CUDA allocation.
- The H100 training run is separate and writes to `optimizer/results/modal-weakfix-h100/`
  when it completes.
- `npm run modal:frontier-fast` is the deadline fallback. It uses fewer GRPO steps, fewer
  generations, shorter completions, and more frequent checkpoints.

## CI

GitHub Actions runs `npm run ci:judge`, which replays:

- benchmark checks
- branch-review recordings through the branch experiment pipeline
- project-review demo
- agent and project repair proof
- repair audit
- frontier artifact validation

The raw frontier gate also runs in CI as an informational shell step. That keeps the public
status honest while still making the failing gate visible until a raw model artifact beats
the baseline.

On pull requests, the workflow reads the generated project-review `pr-comment.md` and uses
`tools/post_forger_pr_comment.js` to maintain one sticky `FORGER PR Guard` comment. The same
run uploads the branch pipeline, project review, applyable patch, repair benchmark outputs,
and frontier artifact as `forger-ci-evidence`.
