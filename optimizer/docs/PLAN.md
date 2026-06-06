# forge-optimizer — Design

A specialized model that **takes unoptimized backend code and rewrites it as efficient,
optimized code** — the skill measured by `forger-bench`. Base: **Qwen3.6-35B-A3B** (MoE,
~3B active). Trained on the SquaredCube rig (RTX PRO 6000 Blackwell, 96GB) with **Unsloth**
(fast SFT + GRPO). Strict contamination control. Ablation studies included.

---

## 1. Task definition

**Input:** a backend task description + (optionally) a naive/unoptimized solution.
**Output:** a functionally-correct solution that minimizes the forger-bench cost model —
round-trips, bytes, rows scanned, and (the real bar) **server work at scale**: no seq scans,
no fetch-all-then-filter-in-JS, no PostgREST-cap correctness bugs.

Two framings, both trained:
- **Optimize (primary):** given naive code + task, output optimized code. The "code → better
  code" transform you asked for.
- **Author:** given just the task, output optimal code directly (matches the eval format).

---

## 2. Why this is a real, learnable skill

forger-bench proved frontier models systematically fail specific patterns: every model
failed `auth.owner_scope`, most failed `ai.batch_embed`, and **every "fetch-all" solution
silently breaks at 100k rows** (PostgREST 1000-row cap → wrong results). These are
*consistent, nameable* failure modes — exactly what a specialist can learn to fix. The base
Qwen3.6 scored 56 on request-cost; the goal is a fine-tune that beats the frontier
(codex 87, claude 82) on the sealed test, especially on the resource axis.

---

## 3. Contamination control (hard requirement)

The model is evaluated on forger-bench's **39 sealed test tasks** (13 concepts × 3). To keep
the eval honest:

1. **Never train on a test task.** Training data is generated ONLY from the `train` split
   entities + freshly-synthesized tasks on **disjoint entities** (table/column names never
   used in any test task — enforced by `forger-bench/bench/contamination.js` semantics).
2. **Concept overlap is allowed and intended** (the model SHOULD learn "pagination") — but
   **entity overlap is forbidden** (it must not memorize `articles`/`logs`/etc.).
3. Hold out 2 of the 13 concepts ENTIRELY from training (e.g. `top_n`, `in_list`) as a
   **generalization probe** — measures whether the model learned *optimization* vs *concept
   templates*. Reported separately.
4. A `contamination_check.py` re-verifies: no test entity, no test task id, and the held-out
   concepts never appear in any training example. Must pass before any training run.

---

## 4. Data generation (no contamination)

Each training example = `{ prompt, chosen (optimal), rejected (naive) }`, generated
programmatically from forger-bench task factories on **fresh entities**:

- **Source of truth:** forger-bench's oracle (optimal) and naive (wasteful) per concept —
  these are *correct by construction* (calibrated) and define the optimization target.
- **Entity diversity:** generate N variants per concept with randomized table/column/entity
  names drawn from a large pool DISJOINT from test entities → thousands of examples, zero
  leakage.
- **Scale-awareness:** include the 100k-row reality in prompts ("the table has ~100k rows")
  so the model learns to avoid the fetch-all correctness trap, not just micro-optimize.
- **Three data modes (ablation knobs):**
  - `author`: task → optimal code (single-shot).
  - `optimize`: task + naive code → optimal code (the transform).
  - `repair`: task + a scale-buggy solution → corrected+optimized code.

Formats produced: **SFT** (prompt → chosen) and **preference pairs** (chosen vs rejected)
for DPO, plus the live **grader reward** for GRPO.

---

## 5. Training — agentic, CUDA-Agent-style (refs: arXiv 2602.24286)

We adopt CUDA-Agent's architecture: the model is an **agent that iterates against an
execution+verification+cost harness**, not a single-shot generator. forger-bench is our
equivalent of their compile+verify+profile loop — it already returns correctness, the
scaleBug flag, and the exact server-cost metrics. Their key findings we apply:

MoE caveat (Unsloth): **bf16 16-bit LoRA, NOT QLoRA 4-bit**. 35B-A3B bf16 LoRA ≈ 74GB → fits
96GB with headroom for rollouts.

```python
from unsloth import FastLanguageModel
model, tok = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3.6-35B-A3B", max_seq_length=8192,  # multi-turn agentic ctx
    load_in_16bit=True, full_finetuning=False, fast_inference=True)  # vLLM rollouts
model = FastLanguageModel.get_peft_model(model, r=32, lora_alpha=64,
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])
```

### The agentic loop (`train/agent_env.py`)
ReAct-style, per task: **write solution → grade (run vs live/mock + cost metrics) →
observe {correct, scaleBug, tuplesPerReq, score, errors} → refine**. Up to N turns (start
8–12; CUDA-Agent used 150 for CUDA — backend tasks converge far faster). Observation fed back
each turn = the grader's structured result + any runtime error. The model learns its own
debug/optimize strategy rather than a fixed template.

### Discrete milestone reward (their top ablation — beats continuous by ~36pts)
Continuous efficiency reward chases outliers/easy wins; discrete milestones are robust:
```
r = -1  if incorrect OR scaleBug (wrong at 100k — counts as a hard failure / hack)
     1  if correct but wasteful (no real win over naive)
     2  if correct AND beats naive on server cost (>5% fewer tuples/buffers)
     3  if correct AND near-optimal (oracle-class: index scan, no seq scan)
```
scaleBug = -1 is our **anti-reward-hack guard** (their file-permission analog): "fetch 1000
rows and pretend" is the cardinal cheat here, and it's caught, not rewarded.

### Stages (multi-stage warm-up prevents the RL collapse they saw at ~17 steps)
1. **SFT** (`train/sft.py`) — author+optimize+repair data (§4). Establishes the behavioral
   prior; backend-opt is rare in pretraining, same domain-drift risk they flagged.
2. **RFT** (`train/rft.py`) — rejection fine-tune on the model's OWN passing agentic
   trajectories (outcome filter r>0; pattern filter: valid code, no hallucinated SDK calls).
   Strong actor init before RL.
3. **Agentic GRPO** (`train/grpo.py`) — multi-turn rollouts, milestone reward, `num_generations=8`,
   asymmetric clip (ε_low=0.2, ε_high=0.28, per their stable config). vLLM fast_inference.

Eval ALWAYS greedy + thinking-off; same prompt builder as forger-bench runners → fair.

---

## 6. Ablation studies (required deliverable)

Each ablation re-runs forger-bench (request-cost + resource) on the sealed test:

| # | Ablation | Question it answers |
|---|---|---|
| A0 | Base Qwen3.6-35B-A3B (no training) | Starting point |
| A1 | SFT author-only | Does single-shot optimal-code SFT help? |
| A2 | SFT author+optimize+repair | Does the code→code transform data add over author-only? |
| A3 | A2 + GRPO | Does RL on the grader reward beat SFT alone? |
| A4 | LoRA rank sweep (r=16/32/64) | Capacity vs whack-a-mole across concepts |
| A5 | scale-aware prompts ON vs OFF | Does telling it "100k rows" fix the cap correctness bug? |
| A6 | held-out concepts (top_n,in_list) | Generalization: optimization skill vs concept memorization |

Headline ablation table: each variant's request-cost Score, resource Score, scaleBugs, and
per-domain breakdown vs the frontier baselines (codex 87 / claude 82 / base 56).

---

## 7. Rig / infra

- **SquaredCube** (`ssh squaredcube1` → WSL Ubuntu): RTX PRO 6000 96GB, CUDA 12.8+ (Blackwell
  needs 12.8). One heavy GPU job at a time; `ollama stop` + check `nvidia-smi` before launch;
  respect the user's gaming-pause.
- Base model: pull `unsloth/Qwen3.6-35B-A3B` to the rig (~70GB) via `huggingface-cli`.
- Unsloth install (Blackwell): `pip install unsloth` (pulls torch cu128). Python 3.11–3.13.
- The forger-bench grader (Node) runs on the rig too (for GRPO reward) OR results are scored
  on the laptop — decide by latency; the mock grader is hermetic so it can run rig-side.

---

## 8. Milestones

- **M0:** rig setup — Unsloth installed, base model pulled, a 1-step smoke train works.
- **M1:** data generator (author/optimize/repair on fresh entities) + contamination_check
  passing. Dataset stats.
- **M2:** SFT (A1, A2) + eval harness wired to forger-bench. First ablation rows.
- **M3:** GRPO (A3) with the grader reward. Rank sweep (A4).
- **M4:** scale-aware + held-out ablations (A5, A6). Full ablation table + writeup.

---

## 9. Open decisions

- GRPO reward: pure forger-bench score, or shaped (correctness gate → efficiency bonus →
  scalebug penalty)? Start shaped; ablate.
- DPO between SFT and GRPO? The preference pairs are free from the data gen. Optional A-row.
- Eval cost: resource-axis eval needs the live backend (rate-limited). Use request-cost +
  the hermetic mock for fast per-checkpoint eval; run the expensive resource eval only on
  final ablation winners.
