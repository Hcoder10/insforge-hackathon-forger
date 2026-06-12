# forger-bench

**An efficiency-aware benchmark for AI-generated backend & frontend code, measured against
the InsForge SDK.** Inspired by [Mercury](https://arxiv.org/html/2402.07844v3) — but where
Mercury scores LeetCode CPU runtime, forger-bench scores the **backend cost model**: network
round-trips, bytes over the wire, rows scanned, storage egress, AI tokens, CPU work, disk
bytes, and memory pressure.

> The gap Mercury found (frontier models ~65% correct, <50% efficient) is even wider for app
> code, because "correct but wasteful" backend code — `select('*')` then filter in JS, N+1
> queries, client-side vector search, one-at-a-time embeddings — passes every functional
> test while quietly running up the bill. forger-bench measures that gap.

See **[docs/DESIGN.md](docs/DESIGN.md)** for the full design (cost model, scoring formulas,
task taxonomy, execution model, contamination control, roadmap).

## Status

**M1 — full concept sets + sealed test split + live audit.** 52 tasks (39 sealed test, 13
train) across 5 domains (db 24, vector 8, storage 8, ai 8, auth 4), 13 concepts, each with a
train instance + 3 sealed test instances on distinct entities. Scoring is independently
verified, the test split is contamination-checked, and the mock is audited against a **real
InsForge backend** (live mode).

## Run

```bash
npm run smoke          # sanity-check the instrumented mock     -> SMOKE_OK
npm run calibrate      # assert every task discriminates        -> ALL_TASKS_VALID
npm run verify         # re-derive every score by hand, compare -> VERIFY_OK
npm run contamination  # sealed test split is clean (no leaks)  -> CONTAMINATION_OK
npm run demo           # grade oracle/mid/naive "models" + leaderboard
npm run audit          # audit the mock vs a real InsForge backend (live mode)
npm run check          # smoke + calibrate + verify + contamination in one shot
```

Live audit (`npm run audit`) needs `.env.local` (an InsForge project's URL + anon key) and
seeded tables — see [live/README.md](live/README.md). Without credentials it skips cleanly.

## How scoring works (short version)

Each task ships an **oracle** (optimal), a **naive** (correct but wasteful), and **mid**
solutions. The harness runs them through the instrumented mock to build a per-metric cost
spread, then scores a candidate as its **percentile within that spread** (Mercury's
"Beyond"), blended by the task's per-category metric weights. The harness also adds a small
CPU/disk/memory overlay when a resource axis varies and the oracle is the cheapest reference:

```
score = 0 if incorrect; else 50 + 50 * Σ_m ( weight_m * percentile_m )
```

Leaderboard headline: **Pass** (correctness %), **Score** (mean, 0–100), **Eff** (efficiency
of correct code), and **Gap = Pass − Eff** — the efficiency frontier models leave on the
table.

## Layout

```
docs/DESIGN.md   the source of truth
mock/            instrumented in-process InsForge mock (+ smoke test)
bench/           score / harness / calibrate / verify / contamination / demo
tasks/           db · vector · storage · ai · auth  (concept factories: train + 3 sealed test)
live/            instrument (counting fetch on the real SDK) + audit vs a live backend
```
