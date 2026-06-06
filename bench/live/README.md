# forger-bench — Live Mode

Audits the hermetic mock against a **real InsForge backend**: runs each task's oracle/naive
against both, and asserts the mock's cost rankings match the live backend's. This is the
ground-truth check behind the benchmark's core claim ("score against the mock, trust it
reflects reality").

## How it works

- `live/instrument.js` — wraps the real `@insforge/sdk` with a **counting `fetch`**, so
  candidate code runs byte-identically against the live project while we measure true cost
  at the HTTP layer (each request = one round-trip; request/response body sizes = bytes;
  PostgREST array length = rowsReturned). Exposes the same `{ insforge, metrics }` shape as
  the mock.
- `live/audit.js` — runs `live/audit_tasks.js` against mock + live and compares per-axis
  ranking. Prints `AUDIT_OK` / `AUDIT_FAILED`.

The SDK is ESM-only, so `instrument.js` loads it via dynamic `import()` from CommonJS;
`createLiveBackend()` is therefore async.

## Setup (one-time)

1. **Project + credentials.** Created via `npx @insforge/cli create` — writes `.env.local`
   (`NEXT_PUBLIC_INSFORGE_URL`, `NEXT_PUBLIC_INSFORGE_ANON_KEY`) and `.insforge/project.json`
   (admin key). **Both are gitignored — never commit them.**

2. **Install the SDK:** `npm install @insforge/sdk@latest`.

3. **Seed the audit tables.** Run each statement individually (the CLI's `db query` does not
   reliably persist multi-statement scripts):

   ```bash
   npx @insforge/cli db query "CREATE TABLE forger_posts (id text PRIMARY KEY, title text NOT NULL, body text, created_at int)"
   npx @insforge/cli db query "ALTER TABLE forger_posts ENABLE ROW LEVEL SECURITY"
   npx @insforge/cli db query "CREATE POLICY forger_posts_read ON forger_posts FOR SELECT TO anon, authenticated USING (true)"
   npx @insforge/cli db query "INSERT INTO forger_posts (id, title, body, created_at) SELECT 'posts_'||g, 'Title '||g, repeat('x',200), g FROM generate_series(1,57) g"
   ```

## Run

```bash
node live/audit.js
```

Without `.env.local`, the audit **skips cleanly** (exit 0) and prints that live mode is ready
but needs credentials — so CI without a backend stays green.

## What the audit asserts

Absolute counts can differ between mock and live (the mock approximates byte sizes; real
PostgREST adds headers). What MUST hold is the **ranking on every weighted axis**: the mock
may never claim "A is cheaper than B" when live says the opposite — because the score is a
percentile *within* a per-task spread, so only ordering matters. (In practice the
db.pagination audit matches live exactly on all three axes, including bytesRead.)

## Adding an audit task

Add an entry to `live/audit_tasks.js` with: `setupMock`, weighted `axes`, `oracle`/`naive`
(mock), `oracleLive`/`naiveLive` (live table names), and `verifyLive`. Seed the matching
live table per above.
