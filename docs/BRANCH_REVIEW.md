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

## Outputs

Each run writes:

- `result.json`: structured verdict, branch mode, resource deltas, and timeline.
- `report.md`: judge-readable summary.
- `annotated-merge.sql`: merge SQL with FORGER resource annotations.
- `timeline.json`: ordered execution events.

Recorded demo artifacts live under:

```text
bench/results/demo-recordings/
```

## Current Scenarios

- `slow-query-index`: adds an index for customer order lookups.
- `pagination-scale`: adds a tenant and timestamp index for keyset pagination.
- `storage-metadata`: adds a bucket and owner index for storage object metadata.

Each scenario gates correctness and resource regressions across execution time, CPU time, disk bytes, memory bytes, and sequential scans.
