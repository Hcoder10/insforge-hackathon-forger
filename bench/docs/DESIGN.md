# forger-bench — Design

**An efficiency-aware benchmark for AI-generated backend and frontend code, measured against
the InsForge SDK.** It adapts Mercury-style efficiency scoring to backend resources: round
trips, bytes over the wire, rows scanned, storage bytes, AI tokens, CPU work, disk bytes,
and memory pressure.

> Status: v2 design. Sibling project to the older `insforge-bench` (kept frozen as a
> baseline). This is a clean, parallel track with a broader cost model and full-surface
> coverage. Built and run on the laptop (`C:\Users\sarta\forger-bench`).

---

## 1. Why this exists

The [Mercury benchmark](https://arxiv.org/html/2402.07844v3) showed that leading code LLMs
pass ~65% of tasks functionally but score <50% on **efficiency** — a large gap between
"works" and "works well." Mercury measures that gap for **LeetCode CPU runtime**.

The same gap exists for **app/backend code, but the cost model is different.** A backend's
bill is not CPU cycles — it's **network round-trips, over-fetched bytes, rows scanned,
storage egress, and AI tokens**. An LLM that writes `select('*')` then filters in JS, does
N+1 queries in a render loop, downloads a file just to read its size, or re-embeds
one-at-a-time is **correct and wasteful** — and no existing benchmark catches it.

forger-bench measures *that* gap, against the real InsForge SDK surface.

---

## 2. The cost model (metric basket)

Every candidate solution runs against an **instrumented backend** that counts every call.
The captured metrics:

| Metric | Unit | Catches | Primary domains |
|---|---|---|---|
| `dbOps` | count | round-trips; N+1; not batching | db, auth, vector |
| `bytesRead` | bytes | `select('*')`, no projection, fetch-to-count | db, vector |
| `rowsScanned` | count | missing filters, client-side filtering | db |
| `rowsReturned` | count | over-fetching rows | db |
| `writes` | count | not bulk-writing; re-writing unchanged | db, storage |
| `bytesWritten` | bytes | writing more than needed | db, storage |
| `storageBytes` | bytes | download-to-read-metadata; full pulls | storage |
| `storageOps` | count | per-file ops vs batch remove | storage |
| `aiTokens` | tokens | unbatched embeddings, prompt bloat | ai |
| `aiCalls` | count | one call per item vs batch | ai |
| `realtimeMsgs` | count | chatty publishes, no coalescing | realtime |
| `fnInvocations` | count | round-tripping through functions needlessly | functions |
| `cpuOps` | synthetic ops | CPU work from scans, filtering, sorting, payload processing, AI calls | all |
| `diskBytes` | bytes | table blocks, storage reads/writes, write amplification | all |
| `diskOps` | 8KB blocks | disk/cache block pressure | all |
| `memoryBytes` | bytes | peak payload or intermediate memory pressure | all |
| `wallMs` | ms | end-to-end latency (informational) | all |
| `cpuTotalMs` | ms | measured process CPU time (informational) | all |
| `peakRSS` | bytes | loading huge payloads into memory | all |

`cpuOps`, `diskBytes`, and `memoryBytes` are deterministic mock counters. They are blended
into scoring as a 12% resource overlay when the axis varies across the reference spread and
the oracle is the cheapest reference on that axis. `wallMs`, `cpuTotalMs`, and `peakRSS` are
reported but not weighted by default because they are hardware-noisy.

---

## 3. Scoring — Mercury's "Beyond", adapted to a solution spread

Mercury's core idea: never score *absolute* cost (hardware-dependent) — score the
**percentile of the candidate against a distribution of real solutions for that task.** We
adopt this, but since InsForge has no LeetCode-style solution history, **each task ships its
own mini-distribution**: a hand-written `oracle` (optimal), a `naive` (correct but
wasteful), and 1–3 `mid` solutions in between. Calibration asserts oracle is best and naive
is worst, so the spread is provably discriminating.

### Per-metric percentile (Mercury's `p`)
For task `t`, metric `m`, candidate cost `r`:

```
lo = min(spread costs for m)      # ~ the oracle
hi = max(spread costs for m)      # ~ the naive
clip = min(max(r, lo), hi)
p_m  = (hi - clip) / (hi - lo)    # 1.0 = matched the best, 0.0 = as bad as the worst
                                  # if hi == lo (metric doesn't vary), p_m = 1.0
```

### Task score
```
if not correct:  score = 0                      # Mercury: failed => cost = +inf => p = 0
else:            score = 50 + 50 * Σ_m ( w_t,m * p_m )
```
`w_t,m` = the task's effective metric weights. The task-specific weights keep 88% of the
score. The remaining 12% is assigned to eligible CPU, disk, and memory axes. A resource axis
is eligible only when it varies in the reference spread and the oracle is the cheapest
reference on that axis. This keeps resource scoring stable without rewarding inert metrics.

### Aggregate metrics (the leaderboard headline + the Mercury story)
- **Pass** — % of tasks functionally correct (the `verify` passes).
- **Score** — mean task score (0–100). The headline.
- **Efficiency** — mean of `Σ_m w·p_m` over *correct* tasks only (0–1).
- **Gap = Pass − Efficiency·100** — Mercury's framing: how much efficiency is left on the
  table by code that already works. This is the number that sells the benchmark.

Reported per-category as well (db / storage / ai / auth / realtime / functions / frontend).

---

## 4. Task contract

Every task is a factory producing:

```js
{
  id,              // stable, e.g. "db.pagination.test1"
  domain,          // db | storage | ai | auth | realtime | functions | frontend
  concept,         // e.g. "pagination"
  split,           // train | test   (test ids are sealed; never used for training)
  weights,         // { metric: w, ... }  Σ = 1  — the cost axes that matter for this task
  prompt,          // the natural-language task given to the model
  setup(be),       // seed the instrumented backend (tables, rows, files, ...)
  run(be, code),   // execute the candidate `code` against `be`; returns its result
  verify(be, ctx, result) -> bool,   // functional correctness (lives or dies here)
  oracle,          // optimal solution source (string)
  naive,           // correct-but-wasteful source
  mid: [ ... ],    // 1–3 in-between solutions -> the cost distribution
}
```

The harness runs oracle/naive/mid through the *same* instrumented backend to build the
per-metric `[lo..hi]` spread, then scores the candidate against it. **A task is only valid
if `calibrate` confirms: oracle is correct & cheapest, naive is correct & most expensive.**

---

## 5. Domain coverage (mapped to the real `@insforge/sdk`)

Grounded in the installed InsForge skill docs — only real SDK shapes are used.

### Database (`insforge.database`) — the core
`.from().select()/.insert()/.update()/.delete()/.rpc()`; filters
`eq/neq/gt/gte/lt/lte/like/ilike/in/is`; modifiers `order/limit/range/single/maybeSingle`;
`select('*', {count:'exact'})`; relationships `select('*, child(id)')`.
**Concepts:** column projection · filter pushdown · pagination (`range`+count) · **N+1 via
relationship embed** vs loop · batch insert (array form) · count-exact vs `head:true` ·
exists-check · in-list vs N queries · ilike search · order+limit (top-N) · **aggregation via
`rpc`** vs fetch-all-and-reduce.

### Vector / RAG (`pgvector` + `rpc`)
**The signature efficiency trap:** similarity search via a server-side `match_documents`
`rpc` (returns top-k) vs **client-side distance math** (pulls every row over the wire).
Also: batch-insert embeddings vs one-by-one.

### Auth + RLS (`insforge.auth`)
`auth.uid()` ownership; `getCurrentUser`; profile fetch. **Concepts:** owner-scoped query
(let RLS filter) vs fetch-all-then-filter-by-user-in-JS; one `getCurrentUser` vs repeated.

### Storage (`insforge.storage`)
`.from().upload()/.uploadAuto()/.download()/.remove()/.list()`. **Concepts:** save both
`url`+`key` (so later ops don't re-list) · **batch `remove([keys])`** vs per-file ·
**don't `download()` a file just to read metadata** (use `list`) · upload once vs re-upload.

### AI (`insforge.ai`)
`chat.completions.create` · `embeddings.create` · `images.generate`. **Concepts:** **batch
embeddings** (`input: [...]`) vs a loop of single calls (counts `aiTokens`/`aiCalls`) ·
never store base64 image in DB (upload to storage, save key) · don't resend huge context.

### Realtime (`insforge.realtime`)
`connect/subscribe/publish/on`. **Concepts (correctness-leaning, light efficiency):**
coalesce N publishes into one vs spamming · subscribe once vs per-render · seed presence
from `subscribe()` response vs waiting for own join event.

### Functions (`insforge.functions`)
`.invoke(slug, {body})`. **Concepts:** do the work in one function call vs round-tripping
the client between steps · don't invoke a function for what a single DB query does.

### Frontend (page-level data loading)
Same cost model at **page granularity**: "write the loader/hook for this dashboard." Scored
on round-trips + bytes over the wire — i.e. request waterfalls, N+1 in render, over-fetch.
The candidate returns a data-loading function; the mock counts the backend calls it makes.

---

## 6. Execution substrate

**Mock-first (default).** A hermetic, in-process JS backend that mirrors `@insforge/sdk`
and instruments every call. Deterministic, no Docker, CI-friendly, fast. `createBackend()`
→ `{ insforge, metrics, admin }`. The candidate's code is run in an isolated child process
(`run_one`) so a crash/leak can't corrupt the harness, and `wallMs`, `cpuTotalMs`, and
`peakRSS` are measured cleanly.

**Live mode (optional, later).** Candidate code is **byte-identical** — only the client's
`baseUrl`/`anonKey` change from the mock to a real InsForge project. So every task can be
re-validated against a live backend (real REST, real RLS) once Docker/a project is
available. The mock is the spec; live is the audit.

---

## 7. Contamination control

- **Sealed test split.** Each concept has a `train` instance, **3 sealed `test`
  instances** (distinct entity names/data), and N `train` variants. Test entities never
  appear in any training artifact. Models are never trained on a `test` id.
- Oracle/naive/mid are part of the *grader*, not shipped to the model.
- Prompts are byte-identical across all models (one shared builder) → fair comparison.

---

## 8. Models compared

- **Frontier stand-ins** via local Ollama on SquaredCube (no API keys needed): gpt-oss-120b,
  Nemotron-3-Super, gemma3, qwen3.6 — the same set the old bench used.
- **Real frontier** (optional): drop-in runner with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  / `GEMINI_API_KEY` → Opus / GPT / Gemini.
- **Specialist** (the eventual story): a LoRA-SFT small MoE that **beats the generalists on
  forger-bench** — matching score at a fraction of the generation tokens and active params.

---

## 9. Repo layout

```
forger-bench/
  docs/DESIGN.md          this file
  mock/
    index.js              instrumented in-process InsForge mock (db/auth/storage/ai/realtime/fn)
    smoke.js              sanity check -> SMOKE_OK
  bench/
    score.js              per-metric percentile + task score + aggregates (§3)
    harness.js            gradeSolution(task, code): setup -> run -> verify -> score vs spread
    calibrate.js          assert oracle cheapest+correct, naive priciest+correct, for every task
    run_one.js            execute one candidate in an isolated child process (RSS/wall)
    extract.js            pull code from model output (```js blocks + tool-call params)
    prompt.js             shared SYSTEM prompt + buildMessages(task)
  tasks/
    index.js              registry: all task factories, TRAIN/TEST/VARIANTS/ALL
    db.js                 database concepts
    vector.js             pgvector / RAG
    auth.js               auth + RLS
    storage.js            storage
    ai.js                 AI
    realtime.js           realtime
    functions.js          functions
    frontend.js           page-level data loading
  results/                submissions, scores, leaderboard (gitignored except samples)
  package.json
```

## 10. Milestones

- **M0 (done):** mock + score + harness + calibrate, and one task per core domain with
  oracle/naive/mid. `calibrate` green. ✅
- **M0.5 (done):** independent scoring verification (`bench/verify.js`) + inert-axis guard. ✅
- **M1 (done):** **52 tasks (39 sealed test, 13 train) across 5 domains / 13 concepts**, each
  a concept factory minting a train + 3 sealed test instances on distinct entities;
  contamination check (`bench/contamination.js`); **live-mode audit against a real InsForge
  backend** (`live/`) — moved up from M4 and passing (mock matches live exactly on
  db.pagination). ✅
- **M2 (next):** shared prompt builder + code extractor; Ollama runner to re-baseline
  frontier stand-ins on the 39-task test split; JSON leaderboard + per-category report.
- **M3:** SFT data synth from oracle/naive (the specialist track), then the beat-frontier loop.
- **M4:** realtime/functions efficiency tasks, frontend page-load tasks, more concepts per
  domain; expand the live audit to all domains (seed live tables per concept).

---

## 11. Open questions / notes

- `wallMs`, `cpuTotalMs`, and `peakRSS` stay informational. Deterministic CPU, disk, and
  memory counters carry the resource overlay in mock mode.
- Realtime & functions efficiency is softer to measure hermetically; they start
  correctness-weighted and gain efficiency weight as the mock models their cost.
- The frontend domain is the most novel framing — worth a dedicated writeup once a few page
  tasks exist.
