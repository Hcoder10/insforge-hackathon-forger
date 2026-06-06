# forge-optimizer — Ablation Results

Each ablation re-runs forger-bench (request-cost + resource axes) on the **39 sealed test
tasks** (13 concepts × 3). Variants and questions are defined in `PLAN.md` §6. Frontier
baselines for reference: **codex 87 / claude 82** (request-cost). Base Qwen3.6 = 56.

| Variant | Description | request-cost Score | resource Score | scaleBugs | held-out-concept Score | Notes |
|---|---|---|---|---|---|---|
| **A0** | Base Qwen3.6-35B-A3B (no training) — starting point | **56.34** (pass 56.41) | pending | pending | pending | From `forger-bench/results/score_qwen3.6.json` (ollama, test split, 39/39 extracted). Per-domain: db 61.1, vector 100, storage 82.9, ai 0, auth 0. |
| **A1** | SFT author-only — does single-shot optimal-code SFT help? | pending | pending | pending | pending | pending |
| **A2** | SFT author+optimize+repair — does the code→code transform data add over author-only? | pending | pending | pending | pending | pending |
| **A3** | A2 + GRPO — does RL on the grader reward beat SFT alone? | pending | pending | pending | pending | pending |
| **A4** | LoRA rank sweep (r=16/32/64) — capacity vs whack-a-mole across concepts | pending | pending | pending | pending | pending |
| **A5** | scale-aware prompts ON vs OFF — does telling it "100k rows" fix the cap correctness bug? | pending | pending | pending | pending | pending |
| **A6** | held-out concepts (top_n, in_list) — generalization: optimization skill vs concept memorization | pending | pending | pending | pending | pending |

## How to read this

- **request-cost Score** — the primary headline number (0–100): correctness gate × cost
  efficiency on the request-cost axis, averaged over the 39 sealed tasks. This is the
  per-checkpoint number from the hermetic mock grader, so it is cheap to compute. Compare
  every row against A0 (56) and the frontier (codex 87 / claude 82). Higher is better.
- **resource Score** — the real-bar axis (0–100): server work at scale (rows scanned,
  buffers, seq-scan avoidance) measured against the **live backend**. Per §9, this is
  rate-limited and expensive, so it's run only on final ablation winners — expect many
  rows to stay `pending` until the end. A model can win request-cost yet lose resource if
  it still does fetch-all-then-filter; that gap is the whole point of the project.
- **scaleBugs** — count of tasks (out of 39) where the solution is **wrong at 100k rows**
  (the PostgREST 1000-row cap correctness trap). This is a hard-failure / reward-hack
  signal, not a cost metric. **Lower is better; 0 is the goal.** A5 is the ablation that
  should drive this toward 0; watch it closely there.
- **held-out-concept Score** — request-cost Score restricted to the 2 concepts held out of
  training entirely (`top_n`, `in_list`). This is the generalization probe: it measures
  whether the model learned *optimization* or just memorized *concept templates*. A score
  here close to the overall score = real skill transfer; a large drop = memorization. A6 is
  the dedicated row for this, but it's worth recording for every trained variant.
- **Reading direction** — for Score columns and held-out, higher is better; for scaleBugs,
  lower is better. Treat A0 as the floor and the frontier numbers as the ceiling to beat,
  especially on the resource axis (the stated goal).

### Notes on A0 (base) provenance

A0 is pre-filled from the existing base-model run. Source: `score_qwen3.6.json`
(`model: qwen3.6:latest`, runner ollama, test split). `meanScore = 56.34`, `pass = 56.41`.
The model already solves vector (100) and storage (82.9) cleanly but scores **0 on both ai
and auth** — `ai.batch_embed`, `ai.no_base64_in_db`, and `auth.owner_scope` are the
systematic frontier failure modes the fine-tune targets. resource Score, scaleBugs, and the
held-out-concept Score for A0 are left `pending` because they require the live-backend
resource eval / scaleBug instrumentation, which the request-cost mock run did not produce.
