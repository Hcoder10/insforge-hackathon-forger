# forge-optimizer

A specialized model that **turns unoptimized backend code into efficient, optimized code**.
It is measured by [forger-bench](../bench). Base **Qwen3.6-35B-A3B** (MoE, ~3B
active), trained with **Unsloth** (fast SFT + agentic GRPO) on an RTX PRO 6000 (96GB).

Architecture borrows from **CUDA-Agent** (BytedTsinghua-SIA, arXiv 2602.24286): an agentic
loop where the model writes code, the forger-bench grader *runs + verifies + measures cost*,
and that signal drives iterative refinement and RL — plus their discrete milestone reward,
multi-stage warm-up, and anti-reward-hack guards.

See **[docs/PLAN.md](docs/PLAN.md)** for the full design.

## Pipeline

```
data/gen_data.js          contamination-free synth data (author/optimize/repair) on FRESH
                          entities; held-out concepts (top_n,in_list) for generalization
data/contamination_check.js   HARD GATE: no test entity, no held-out concept, no prompt overlap
train/agent_env.js        the agentic env: code -> run+verify+cost -> milestone reward (-1/1/2/3)
train/sft.py              Stage 1: SFT (Unsloth, MoE bf16 LoRA)
train/grpo.py             Stage 3: agentic GRPO, reward = forger-bench grader via agent_env
eval/gen_eval.py          run a trained adapter on the 39 sealed test tasks -> submission
```

## Contamination control

- Training data uses entity names **disjoint** from every forger-bench test task (gated by
  `contamination_check.js` → `CONTAMINATION_CLEAN`).
- 2 of 13 concepts (`top_n`, `in_list`) held out **entirely** from training → generalization
  probe (optimization skill vs concept memorization).
- GRPO trains only on the train split; the sealed test is never seen.

## Reward (CUDA-Agent milestone scheme — their top ablation)

```
-1  incorrect OR scaleBug (wrong at 100k rows — the PostgREST 1000-row trap = a hard fail/hack)
 1  correct but wasteful
 2  correct AND beats naive on server cost
 3  correct AND near-optimal (index scan, no seq scan)
```

## Ablations (the deliverable)

A0 base · A1 SFT-author · A2 +optimize+repair · A3 +GRPO · A4 rank sweep ·
A5 scale-aware prompt on/off · A6 held-out concepts. Each re-run against forger-bench
(request-cost + resource), reported vs the frontier baselines (codex 87 / claude 82 / base 56).

## Run (on the rig)

```bash
node data/gen_data.js 60 data/out && node data/contamination_check.js data/out   # -> CLEAN
python train/sft.py                                                              # Stage 1
python train/grpo.py                                                             # Stage 3
python eval/gen_eval.py sft train/sft_adapter                                    # eval
node ../bench/bench/eval_submission.js ../bench/results/sub_fo-sft.json
```

Status: scaffolding complete; rig has Unsloth + torch cu128 on the Blackwell; base model
downloading. Next: end-to-end smoke train, then the ablation sweep.
