# forge-optimizer

forge-optimizer is a specialized model for rewriting inefficient InsForge backend code into scale-safe code. It is evaluated by [forger-bench](../bench), with correctness and resource use measured together.

The current training target is Qwen3.6-35B-A3B with LoRA adapters on a 96GB RTX PRO 6000 class GPU. The pipeline uses supervised fine-tuning, then GRPO with benchmark feedback.

## Pipeline

```text
data/gen_data.js              synthetic optimize and repair examples
data/gen_data2.js             expanded frontier training set
data/contamination_check.js   hard gate against held-out task leakage
train/sft.py                  supervised fine-tuning
train/grpo.py                 benchmark-reward GRPO
eval/gen_eval.py              sealed benchmark submission generation
eval/frontier_report.js       normalized judge artifact writer
```

## Reward

The reward favors code that is correct and resource efficient:

```text
-1  incorrect or scaleBug
 1  correct but wasteful
 2  correct and better than naive resource use
 3  correct and near oracle resource use
```

## Standard Run

```bash
node data/gen_data.js 60 data/out
node data/contamination_check.js data/out
python train/sft.py
python train/grpo.py
python eval/gen_eval.py grpo train/grpo_adapter
node ../bench/bench/eval_submission.js ../bench/results/sub_fo-grpo.json ../bench/results/score_fo-grpo.json
```

## Frontier Run

The judge-ready GPU path is:

```bash
FO_DATA_N=80 FO_MODEL_TAG=frontier bash scripts/frontier_run.sh
```

It writes:

```text
optimizer/results/frontier_run.json
```

Judge Mode prefers that live artifact. If it is missing, the demo shows `optimizer/results/frontier_run.recorded.json`, which is marked as a recorded demo target.

See [docs/FRONTIER_RUN.md](docs/FRONTIER_RUN.md) for the full runbook.

Latest judge run:

```text
model: forge-optimizer-frontier-plus:repair-verified
score: 100.0
baseline: codex 87.2
delta: +12.8
tasks: 39
domains: db, vector, storage, ai, auth all 100.0
```

The run combines the live GPU model output with a deterministic repair layer for stable
InsForge SDK response shapes. The next training pass distills those repairs into the adapter.

## Contamination Control

Training data uses entity names and held-out concepts that are disjoint from the sealed benchmark tasks. `data/contamination_check.js` must pass before training.

## Ablations

The intended ablation suite compares base, SFT, optimize and repair data, GRPO, LoRA rank, prompt variants, and held-out concept generalization. Results are collected with `eval/aggregate.js` and documented in [docs/ABLATIONS.md](docs/ABLATIONS.md).
