# FORGER Project Review: insforge-customer-portal

Status: **NEEDS-REVIEW**

Project: `optimizer/fixtures/agent_projects/insforge-customer-portal`  
Mode: `dry-run`  
Files scanned: `3`  
Files changed: `3`  
Repairs found: `3`

## Resource Axes

- CPU: flags row-by-row JavaScript work that should stay inside the database or storage service.
- Memory: flags full-table and full-file reads that scale with dataset size.
- Disk: flags unnecessary backend reads, cache churn, and file downloads.
- Correctness: flags InsForge SDK response-shape bugs and API usage that fails under real data.

## Findings

### src/feed.js

- Uses projected columns, exact count, and server pagination.
- Repaired copy: `repaired/src/feed.js`

### src/profiles.js

- Uses array insert format expected by the InsForge SDK.
- Repaired copy: `repaired/src/profiles.js`

### src/sessionDocs.js

- Handles the { data, error } current-user response shape before reading user.id.
- Repaired copy: `repaired/src/sessionDocs.js`
