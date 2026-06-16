# FORGER PR Guard

Status: **NEEDS-REVIEW**

Project: `optimizer/fixtures/agent_projects/insforge-customer-portal`
Mode: `deterministic-fallback`
Files scanned: `3`
Files with repairs: `3`
Repairs: `3`

Model: `not configured; deterministic verifier fallback`

## Apply Patch

```bash
git apply --directory optimizer/fixtures/agent_projects/insforge-customer-portal bench/results/demo-recordings/project-review-customer-portal/forger.patch
```

## Checks

- Correctness: InsForge SDK response shapes and API usage.
- CPU: row-by-row JavaScript work that should stay server-side.
- Memory: full-table and full-file reads that grow with dataset size.
- Disk: avoidable backend reads, cache churn, and storage downloads.

## Findings

### src/feed.js

- Uses projected columns, exact count, and server pagination.

### src/profiles.js

- Uses array insert format expected by the InsForge SDK.

### src/sessionDocs.js

- Handles the { data, error } current-user response shape before reading user.id.
