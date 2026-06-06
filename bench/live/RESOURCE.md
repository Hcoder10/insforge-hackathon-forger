# forger-bench — Resource-Aware Scoring

The request-cost model (round-trips + wire bytes, in the mock) is a useful first proxy but
it is **blind to what actually bills a backend under real data and load**: sequential scans,
buffer/disk I/O, server CPU time, and rows Postgres physically touches. A `select('*')` that
seq-scans a million rows and an indexed lookup are *one round-trip each with identical wire
bytes* — request-cost scores them the same. That's why the request-cost leaderboard shows
~100% efficiency across the board: toy data (40–200 rows) + a 2–3 solution spread saturates
the percentile, and the real failure mode ("correct in dev, melts at 3 users") is invisible.

This layer fixes that by scoring on **real Postgres execution metrics at scale**.

## The signal: EXPLAIN (ANALYZE, BUFFERS)

`live/explain.js` runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the live InsForge
Postgres and extracts, recursively over the plan tree:

| Metric | What it captures |
|---|---|
| `buffers` (shared hit + read) | 8KB blocks touched — the core I/O cost; a seq scan touches ~the whole table |
| `actualTimeMs` | real server-side execution time (no network noise) |
| `seqScans` | count of sequential scans — the cardinal sin at scale |
| `actualRows` / `planRows` | rows the DB physically processed vs estimated |

`live/resource_score.js` scores these with the same Mercury-percentile method as
request-cost, but the spread is built from the **real plans of oracle vs naive at scale**
and the axes are server resources: `{ buffers 0.5, actualTimeMs 0.3, seqScans 0.2 }`.

## Empirical validation (live, scale_test = 100k rows)

`node live/resource_demo.js`:

```
solution          nodeType            buffers   time(ms)  seqScans
A indexed-eq      Bitmap Heap Scan       104      0.48         0
B unindexed       Seq Scan              1914     15.08         1
C select-star     Seq Scan              1914      9.13         1

solution          request-cost-score   RESOURCE-score
A indexed-eq                  100            100.0
B unindexed                   100             50.0      <- request-cost can't see this
C select-star                  50             56.1
```

Request-cost scores A and B **identically** (1 query, same bytes). The resource model
exposes B as a seq scan touching **18× the buffers** and halves its score — the difference
that decides whether code survives real data.

## The realistic resource benchmark (accurate-to-cloud)

`live/run_resource_bench.js` runs each model's ACTUAL submitted code against the live
100k-row table under N concurrent users, and scores on **server work per request** measured
from Postgres' own stat tables (`pg_stat_user_tables` + `pg_statio_user_tables`):

- `tuplesPerReq` — rows the DB physically read per request (seq_tup_read + idx_tup_fetch Δ)
- `blocksPerReq` — 8KB buffers touched per request (heap_blks_read + hit Δ)
- `seqPerReq`    — sequential scans per request

It also reports `rps` (sustained throughput) and `scaleBugs` (below). Score = Mercury
percentile over `{tuplesPerReq .5, blocksPerReq .3, seqPerReq .2}`, spread anchored by the
task's oracle vs naive measured the same way.

## The honest finding — accurate to the cloud (corrected)

My first pass claimed "network RTT dominates, so load testing is useless." That was **half
right and the wrong half mattered.** The accurate picture, learned by actually running it:

1. **RTT confounds LATENCY, not SERVER WORK.** A ~80ms round-trip inflates p50/p95 equally
   for every solution, so latency-based load scores DO wash out single-read differences.
   But the *server-side* counters — tuples read, buffers touched, seq scans — are pure
   backend work and are **completely RTT-immune**. A seq scan over 100k rows reads 100k
   tuples whether the client is 1ms or 80ms away. So we score on those, not on latency.
   This is why the benchmark is accurate to the cloud: it measures what the server does,
   which is identical to what it would do under any client.

2. **Throughput (rps) IS meaningful even over RTT** — because under concurrency the bottleneck
   shifts from RTT to server capacity. Efficient code sustained ~1.5–2× the rps of the naive
   in testing (e.g. top_n oracle 28 rps vs naive 11), because the naive's seq scans saturate
   the backend. So rps is reported as the real-world "effect," with server-work as the "cause."

3. **THE BIG ONE — scale exposes CORRECTNESS bugs the toy mock hides.** PostgREST caps every
   response at **1000 rows**. At 100k rows, a "fetch everything and process in JS" solution
   (paginate, count, top-N by sorting) silently receives only 1000 of 100k rows and returns
   **WRONG results** — e.g. a paginator reports `total: 1000` instead of `100000`. The toy
   mock (small tables, no cap) scores these as correct; the live backend at scale proves
   them broken. The resource benchmark re-verifies correctness AT SCALE
   (`live/scale_verify.js`) and flags these as `scaleBugs`. **This is the deepest result:
   "correct but wasteful" code at toy scale is often "wasteful AND wrong" at real scale** —
   exactly the production failure you hit at a few concurrent users on a full project.

4. **Some task specs don't translate to scale.** `column_projection` and `filter_pushdown`
   ask to "return ALL matching rows" — impossible past the 1000-row cap, so even the correct
   oracle can't satisfy them at 100k. The right answer at scale is to paginate, which those
   specs don't allow. They're a toy-data artifact and are **excluded** from resource scoring
   (kept in the request-cost suite). Resource scoring covers the concepts that do translate:
   pagination, count_only, top_n, in_list.

### Net: the request-cost leaderboard's ~100% efficiency was an artifact of toy data + a
2-solution spread. The resource benchmark, on real 100k-row cloud data under load, both
spreads efficiency honestly (server work per request) AND catches the correctness failures
that only appear at scale.

## Legacy single-shot probes

`live/explain.js` (EXPLAIN ANALYZE per query) and `live/load.js` (latency under load) remain
as cross-checks. EXPLAIN is the cleanest single-query resource view; the load latency numbers
are RTT-influenced (see finding #1) and are informational, not scored.

## Setup

```bash
# scale table (100k rows) used by the demo + resource tasks
npx @insforge/cli db query "CREATE TABLE scale_test (id bigserial primary key, owner text, val int, body text)"
npx @insforge/cli db query "INSERT INTO scale_test (owner,val,body) SELECT 'u'||(g%1000), g, repeat('x',100) FROM generate_series(1,100000) g"
npx @insforge/cli db query "CREATE INDEX idx_scale_owner ON scale_test(owner)"   # owner indexed; val left unindexed on purpose
```

## Run

```bash
node live/resource_demo.js   # EXPLAIN-based resource scores vs request-cost, at scale
```

## Status / roadmap

- ✅ EXPLAIN capture + resource percentile scoring, validated on 100k rows.
- ✅ Concurrent-load harness (with the documented network-RTT caveat).
- ▢ Wire resource scoring into the task suite: each task gets a `liveSql(scale)`; grade
  candidates by EXPLAIN at scale instead of (or alongside) mock request-cost.
- ▢ Seed a scaled live table per concept; re-baseline the models on the resource axis so
  the leaderboard's efficiency column reflects server cost, not request count.
- ▢ Add `diagnose db` deltas (cache-hit ratio, lock waits, bloat) and `diagnose metrics`
  (CPU/mem/disk) for whole-workload scoring.
