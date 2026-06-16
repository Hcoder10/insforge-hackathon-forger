# FORGER Branch Experiment Pipeline

Status: **READY-TO-PROMOTE**

Generated: `2026-06-16T05:00:02.266Z`
Execution mode: `recorded`
Scenarios: `3`

## Promotion Gate

- All branch experiments passed the promotion gate.

## Branch Experiments

| Scenario | Status | Branch mode | Execution | Merge preview |
|---|---|---|---|---|
| pagination-scale | PASS | schema-only | recorded | bench/results/demo-recordings/branch-review-pagination-scale/annotated-merge.sql |
| slow-query-index | PASS | schema-only | recorded | bench/results/demo-recordings/branch-review-slow-query-index/annotated-merge.sql |
| storage-metadata | PASS | schema-only | recorded | bench/results/demo-recordings/branch-review-storage-metadata/annotated-merge.sql |

## Resource Rollup

| Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|
| actualTimeMs | 476.4 | 26.9 | 94.4% better |
| cpuTimeMs | 464.6 | 25.0 | 94.6% better |
| diskBytes | 60.3 MB | 1.5 MB | 97.5% better |
| memoryBytes | 136.0 MB | 8.3 MB | 93.9% better |
| seqScans | 3.0 | 0.0 | 100.0% better |

## CI/CD Stages

| Stage | Status | Command |
|---|---|---|
| benchmark | PASS | `npm run check` |
| branch experiments | PASS | `npm run branch-pipeline` |
| project repair proof | PASS | `npm run proof:repair` |
| frontier artifact validation | PASS | `npm run frontier-validate` |
| raw model gate | INFORMATIONAL | `npm run frontier-gate:raw` |

## Post-Merge Runtime Plan

Branch merge only applies backend data, schema, function definitions, and config rows. Runtime code still needs deployment when it changed.

| Runtime | Rule | Command |
|---|---|---|
| database merge | required when touched | npx @insforge/cli branch merge <name> --dry-run --save-sql merge.sql, then merge after review |
| edge functions | optional | npx @insforge/cli functions deploy <slug> --file <file> |
| frontend | optional | npx @insforge/cli deployments deploy . |
| compute services | optional | npx @insforge/cli compute update <id> --image <image> |
| production canary | required when touched | node live/run_resource_bench.js 3 3000 |
