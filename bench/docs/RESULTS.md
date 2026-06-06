# forger-bench Results

All numbers below are taken verbatim from the harness output in `results/`
(`leaderboard.json`, `resource_*.json`, `score_*.json`, `resource_run.log`).
The benchmark has two axes:

1. **Request-cost axis** — does the solution produce the *correct* result while
   keeping its per-request resource footprint (db ops, bytes read, rows
   returned, storage ops, ai calls/tokens, etc.) inside the oracle bounds? A
   passing task scores 100; the score collapses to 0 the moment the result is
   wrong. `pass == meanScore` for every fully-efficient model, so they are
   reported together.
2. **Resource axis** — a *much harder* honest bar: solutions are re-run under
   concurrent load against **real 100k-row data** and scored by how close their
   true server cost (tuples/blocks scanned per request) comes to the oracle.

Split: `test`, 39 cases per model, 5 domains (db=18, vector=6, storage=6, ai=6,
auth=3).

---

## (a) Request-cost leaderboard

Per-model overall Score (= pass rate, since meanEff is 1 for all passing tasks),
with per-domain pass/score breakdown. Source: `leaderboard.json`
(7 ranked models) plus `score_devin.json` (devin-swe-1.6 was scored but is not
in `leaderboard.json`; inserted in rank order).

| Rank | Model | Overall Score | db (n=18) | vector (n=6) | storage (n=6) | ai (n=6) | auth (n=3) |
|-----:|-------|--------------:|----------:|-------------:|--------------:|---------:|-----------:|
| 1 | codex | 87.18 | 100 | 100 | 100 | 16.67 | 100 |
| 2 | claude | 82.05 | 100 | 100 | 100 | 16.67 | 33.33 |
| 3 | gemini | 71.79 | 100 | 66.67 | 50 | 50 | 0 |
| 3 | gpt-oss:120b | 71.79 | 100 | 50 | 66.67 | 50 | 0 |
| 3 | devin-swe-1.6 | 71.79 | 94.44 | 100 | 66.67 | 16.67 | 0 |
| 6 | nemotron-3-super:latest | 61.54 (pass) / 60.00 (meanScore) | 83.33 pass / 80.00 score | 50 | 50 | 50 | 0 |
| 7 | qwen3.6:latest | 56.41 (pass) / 56.34 (meanScore) | 61.11 | 100 | 83.33 pass / 82.87 score | 0 | 0 |
| 8 | gemma3:27b | 5.13 | 0 | 16.67 | 16.67 | 0 | 0 |

Notes from the JSON:
- codex, claude, gemini, gpt-oss:120b, devin, gemma3 all have `meanEff = 1`
  (`gap = 0`): when correct, they stayed inside the per-request bounds, so
  pass == meanScore.
- nemotron has a real efficiency `gap` of 3.077 (`meanEff 0.9500`,
  `meanEffAll 0.5846`) — it passes some db tasks but burns more resources than
  the bound allows; its db meanScore (79.9995) is below its db pass (83.33).
- qwen3.6 has a small efficiency gap of 0.1417 (`meanEff 0.9975`), concentrated
  in storage (`meanEff 0.9890`, score 82.87 vs pass 83.33).
- devin and codex tie among the strong models on db efficiency, but devin drops
  one db case (94.44 vs 100) and collapses on ai (16.67) and auth (0).

---

## (b) Resource-axis leaderboard (partial) — the honest, harder bar

Only **codex** and **claude** were run on the resource axis (12 DB tasks each,
4 concurrent users, 4000 ms/solution). Source: `resource_codex.json`,
`resource_claude.json`, `resource_run.log`.

| Model | Resource pass | Resource meanScore | mean rps | scaleBugs |
|-------|--------------:|-------------------:|---------:|----------:|
| claude | 75% | **53.19** | 22.2 | 0 |
| codex | 75% | **53.12** | 20.7 | 0 |

**Resource Scores (≈53) are far BELOW the request-cost Scores (87 / 82).**
On the toy-data request-cost axis both models score in the 80s on db; under real
concurrent load against 100k rows their true server cost lands them at ~53. The
resource axis is the honest, much harder bar.

Where the resource score is spent (per-record `score`, `resource_codex.json` /
`resource_claude.json`):

| Task | codex score | claude score |
|------|------------:|-------------:|
| db.pagination.test1 | 64.25 | 58.86 |
| db.pagination.test2 | 60.53 | 59.13 |
| db.pagination.test3 | 62.64 | 65.31 |
| db.count_only.test1 | 50.00 | 50.00 |
| db.count_only.test2 | 50.00 | 55.04 |
| db.count_only.test3 | 50.00 | 50.00 |
| db.top_n.test1 | 100 | 100 |
| db.top_n.test2 | 100 | 100 |
| db.top_n.test3 | 100 | 100 |
| db.in_list.test1 | 0 (errors=506,987) | 0 (errors=441,233) |
| db.in_list.test2 | 0 (errors=526,783) | 0 (errors=572,811) |
| db.in_list.test3 | 0 (errors=226,081) | 0 (errors=498,996) |

- `top_n` is the only family both models nail at scale (tuplesPerReq 4–5,
  blocksPerReq 1, eff = 1) — they pushed `ORDER BY ... LIMIT` to the DB.
- `pagination` and `count_only` only score ~50–65: they still drag ~80k–97k
  tuples and 600–840 blocks **per request** (e.g. claude pagination.test1
  `tuplesPerReq:89695, blocksPerReq:838`), i.e. near-full table scans where the
  oracle uses an index.
- `in_list` is a hard 0 for both — every request errored
  (`rps:0, count:0`, hundreds of thousands of errors), so no resource credit.
- The resource run ended with the live backend returning
  `fb_table_stats: Too many requests from this IP` (rate limited), which is why
  the resource axis is partial.

---

## (c) scaleBug finding — the 1000-row PostgREST cap

The resource harness (`live/resource_bench.js`) re-verifies each task with
`verifyScale(result)` against the **live 100k-row** table, not the toy mock. Its
own comment states the trap:

> the PostgREST 1000-row cap making a fetch-all paginator return
> **total=1000 instead of 100000**.

`resource_run.log` records the head-to-head between the **oracle** solution
(index/`LIMIT`/count-pushdown) and the **naive** "fetch all rows, then process
in JS" solution. Every naive solution that tries to count or page by pulling the
table is flagged `SCALEBUG` and `ok:false`, because the response is silently
truncated at 1000 rows, so the JS-side aggregate is **WRONG**:

| Task | oracle (tpr, ok) | naive (tpr, ok) |
|------|------------------|-----------------|
| db.pagination.test1 | tpr 88,531, ok true | tpr 10,992, ok **false, SCALEBUG** |
| db.pagination.test2 | tpr 86,181, ok true | tpr 5,305, ok **false, SCALEBUG** |
| db.pagination.test3 | tpr 91,533, ok true | tpr 13,873, ok **false, SCALEBUG** |
| db.count_only.test1 | tpr 89,620, ok true | tpr 10,571, ok **false, SCALEBUG** |
| db.count_only.test2 | tpr 87,015, ok true | tpr 3,256, ok **false, SCALEBUG** |
| db.count_only.test3 | tpr 90,754, ok true | tpr 10,349, ok **false, SCALEBUG** |
| db.top_n.test1 | tpr 5, ok true | tpr 932, ok **false, SCALEBUG** |
| db.top_n.test2 | tpr 5, ok true | tpr 917, ok **false, SCALEBUG** |
| db.top_n.test3 | tpr 5, ok true | tpr 887, ok **false, SCALEBUG** |

Key point: the naive paginator/counter reads *fewer* tuples than the oracle
(e.g. 10,992 vs 88,531) precisely **because it was capped at 1000 rows** — it
looks cheap but it returns a `total` of 1000 instead of 100000, so it fails the
scale check. (`db.in_list.*` are `ok:false` on both oracle and naive with
tpr 0 — those tasks errored out entirely rather than hitting the cap.)

In `score_*.json` every per-record `scaleBug` is `false` and both resource
leaderboards report `scaleBugs: 0` — meaning the actual model submissions for
the scored db tasks did **not** fall into this trap; the SCALEBUG flag fires on
the harness's built-in `naive` reference solution, demonstrating that the
fetch-all-then-process-in-JS pattern is the wrong answer the benchmark is
designed to catch.

---

## (d) Per-domain failure patterns across models

Pass rates per domain (from each model's `agg.domains`):

| Domain | codex | claude | gemini | gpt-oss | devin | nemotron | qwen3.6 | gemma3 |
|--------|------:|-------:|-------:|--------:|------:|---------:|--------:|-------:|
| db | 100 | 100 | 100 | 100 | 94.44 | 83.33 | 61.11 | 0 |
| vector | 100 | 100 | 66.67 | 50 | 100 | 50 | 100 | 16.67 |
| storage | 100 | 100 | 50 | 66.67 | 66.67 | 50 | 83.33 | 16.67 |
| ai | 16.67 | 16.67 | 50 | 50 | 16.67 | 50 | 0 | 0 |
| auth | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Patterns:

- **ai is the universal weak spot.** No model exceeds 50% on ai. The two best
  request-cost models (codex, claude) and devin score only **16.67%** (1/6),
  and qwen3.6 + gemma3 score **0%**. The failing ai records are the
  `ai.no_base64_in_db.*` family — in `score_codex.json` / `score_claude.json`
  all three `no_base64_in_db` cases are `correct:false` (errors like
  *"No image bytes returned"*, *"Cannot read properties of undefined"*), and
  `ai.batch_embed` partially fails too (codex fails test1 & test3; claude fails
  test1 & test2). So **every model fails most of the ai domain**, and the
  `no_base64_in_db` concept is failed by every model.

- **auth is failed by almost everyone — only codex passes it.** codex is the
  sole model at 100% auth; **claude, gemini, gpt-oss, devin, nemotron, qwen3.6,
  and gemma3 all score auth at the bottom** (claude 33.33%, every other non-codex
  model 0%). The concept is `auth.owner_scope`: in `score_claude.json` test1 and
  test3 return `rowsReturned:0` (`correct:false`) while only test2 passes; in
  `score_gemini.json` / `score_gpt-oss-120b.json` all three return
  `rowsReturned:0` and fail. Models drop owner-scoped rows entirely instead of
  filtering to the owner.

- **db is the strongest domain** — perfect (100%) for codex, claude, gemini,
  gpt-oss; near-perfect for devin (94.44%). It degrades only on the weaker
  models (nemotron 83.33, qwen3.6 61.11, gemma3 0).

- **vector / storage are mid-tier and model-dependent.** gemini fails 2/6
  vector (`vector.similarity.test2/3`, error
  *"insforge.database.rpc(...).select is not a function"*) and half of storage;
  gpt-oss fails all 3 `vector.embed_insert` and 2/3 `storage.batch_remove`;
  qwen3.6 is perfect on vector but weak on db.

- **gemma3:27b fails everything** (overall 5.13%): 0% on db, ai, and auth, and
  only 1/6 on vector and storage.

**Domains failed by *every* model:** ai (no model > 50%, and the
`no_base64_in_db` concept is 0 across the board). **Domains failed by every
model except one:** auth (only codex passes; all 7 others are at 0–33%).
