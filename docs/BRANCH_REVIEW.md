# FORGER Branch Review

FORGER Branch Review is a branch-aware review gate for InsForge backend changes. It creates a repeatable workload, compares baseline and candidate resource use, and writes an annotated merge preview for judge review.

The workflow follows InsForge backend branching:

- `schema-only` branches are fast sandboxes for schema and synthetic seed data.
- `full` branches copy production-like data when realistic scale matters.
- `branch merge --dry-run --save-sql` produces a merge preview before anything is applied.
- Branch cleanup is explicit, because merge does not delete the branch.

Source: https://insforge.dev/blog/backend-branching

## Commands

Recorded mode is the default and does not create an InsForge branch:

```bash
npm run branch-review
npm run branch-review:all
npm run branch-pipeline
```

Live mode creates and deletes a real backend branch:

```bash
node tools/forger.js branch-review \
  --scenario slow-query-index \
  --live \
  --branch forger-demo \
  --mode schema-only
```

Use `--keep-branch` only when you want to inspect the branch after the run.

## Branch Experiment Pipeline

The pipeline command runs every workload, writes the individual branch review artifacts, and
then creates one promotion artifact:

```text
bench/results/demo-recordings/branch-pipeline/pipeline.json
bench/results/demo-recordings/branch-pipeline/pipeline.md
```

The promotion gate requires:

- a branch review result for every selected workload
- expected rows and result shape preserved
- no sequential scan when the workload forbids it
- actual time, CPU, disk, and memory within workload thresholds
- dry-run merge SQL written for human review before promotion

The pipeline also records the required post-merge runtime checklist. InsForge branch merge
does not redeploy code, so functions, frontend deployments, and compute services must be
redeployed when those runtimes depend on the merged backend change.

## GitHub Actions

`judge-ci` runs on push and pull request. It uses recorded evidence by default so regular CI
does not create paid InsForge branches.

`branch-promotion` is a manual workflow for live branch promotion. Required secrets:

- `INSFORGE_EMAIL`
- `INSFORGE_PASSWORD`
- `INSFORGE_PROJECT_ID`
- `INSFORGE_ORG_ID` when the project link needs an org id

The workflow runs the selected scenario on a live branch, saves dry-run merge SQL, and only
applies the merge when `merge_after_review` is explicitly set to `true` in the dispatch.

## Outputs

Each run writes:

- `result.json`: structured verdict, branch mode, resource deltas, and timeline.
- `report.md`: judge-readable summary.
- `annotated-merge.sql`: merge SQL with FORGER resource annotations.
- `timeline.json`: ordered execution events.

The pipeline writes:

- `pipeline.json`: promotion status, resource rollup, scenario matrix, and CI/CD stages.
- `pipeline.md`: judge-readable summary of the same data.

Recorded demo artifacts live under:

```text
bench/results/demo-recordings/
```

## Current Scenarios

- `slow-query-index`: adds an index for customer order lookups.
- `pagination-scale`: adds a tenant and timestamp index for keyset pagination.
- `storage-metadata`: adds a bucket and owner index for storage object metadata.

Each scenario gates correctness and resource regressions across execution time, CPU time, disk bytes, memory bytes, and sequential scans.
