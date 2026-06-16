# forge-optimizer

forge-optimizer is a specialized model for rewriting inefficient InsForge backend code into scale-safe code. It is evaluated by [forger-bench](../bench), with correctness and resource use measured together.

The current training target is Qwen3.6-35B-A3B with LoRA adapters on a 96GB RTX PRO 6000 class GPU. The pipeline uses supervised fine-tuning, then GRPO with benchmark feedback.

Canonical model link: [squaredcuber/forge-optimizer-qwen3.6-35b-a3b](https://huggingface.co/squaredcuber/forge-optimizer-qwen3.6-35b-a3b).

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

For a repair-verified evaluation, which applies the deterministic SDK-shape verifier after
model generation:

```bash
FO_DATA_N=80 FO_MODEL_TAG=frontier-plus-distill FO_REPAIR=1 bash scripts/frontier_run.sh
```

It writes:

```text
optimizer/results/frontier_run.json
```

Judge Mode prefers that live artifact. If it is missing, the demo shows `optimizer/results/frontier_run.recorded.json`, which is marked as a recorded demo target.

See [docs/FRONTIER_RUN.md](docs/FRONTIER_RUN.md) for the full runbook.

Latest audited raw GPU model run:

```text
model: forge-optimizer-frontier:frontier-plus-raw
score: 83.3
baseline: codex 87.2
delta: -3.9
tasks: 39
domains: db 91.7, vector 100.0, storage 66.7, ai 50.0, auth 100.0
```

The deterministic repair layer is tracked separately. It can score `100.0` on the sealed
benchmark, but `npm run frontier-audit:repair` confirms that it can do that with empty model
output. Treat it as a verifier/prototype and distillation target, not as a model-only score.

For project review and PR Guard, the model is used through an OpenAI-compatible endpoint:

```bash
FORGE_OPT_URL=http://127.0.0.1:8901 \
node ../tools/forger.js project-review --project path/to/insforge-app --model-required
```

That path sends direct InsForge SDK files to forge-optimizer first for compact issue findings,
then applies the deterministic SDK-shape verifier to produce the concrete patch. The report
records model attempts, findings, changes, and failures so a CI run is clear about whether it
used the model or only the verifier fallback.

The local server is `optimizer/serve_model.py`. It defaults to `PORT=8901`,
`FO_BASE_MODEL=/root/models/Qwen3.6-35B-A3B`, and
`FO_ADAPTER=/root/forge-optimizer/train/sft2_adapter`. Set `FO_REQUIRE_ADAPTER=1` when the
server should fail instead of serving the base model without an adapter.

Served request:

```http
POST /v1/chat/completions
```

```json
{
  "model": "forge-optimizer",
  "temperature": 0,
  "max_tokens": 256,
  "messages": [{ "role": "user", "content": "review or rewrite prompt" }]
}
```

Served response:

```json
{
  "choices": [
    { "message": { "role": "assistant", "content": "model response" } }
  ]
}
```

The raw adapter is also checked with a manual usefulness probe outside the sealed benchmark.
See [docs/MODEL_USEFULNESS.md](docs/MODEL_USEFULNESS.md). The current result is mixed:
database projection, pagination, and storage metadata answers are useful, but image, vector,
and multi-step repair prompts still need a verifier or another training pass.

## Agent Code Repair Benchmark

The code-aware repair benchmark uses saved outputs from existing agents and refuses empty
model output:

```bash
npm run agent-repair:bench
```

Current artifact: `optimizer/results/agent_repair_benchmark.json`.

```text
models: 8
averageBefore: 69.4
averageAfter: 100.0
fixedFailures: 95
regressions: 0
emptyGuard: 0/39 repaired
```

This is the repair proof. It shows the repair engine can fix real generated InsForge SDK
solutions from other agents on the benchmark suite.

The project repair benchmark runs on complete generated InsForge app folders:

```bash
npm run project-repair:bench
```

Current artifact: `optimizer/results/project_repair_benchmark.json`.

```text
projects: 2
cases: 5
beforeCorrect: 3
beforeEfficient: 0
afterCorrect: 5
afterEfficient: 5
fixedCorrectness: 2
fixedEfficiency: 3
regressions: 0
```

Run both repair proofs and the empty-output audit:

```bash
npm run proof:repair
```

These repair results are still separate from the raw model frontier gate:

```bash
npm run frontier-gate:raw
```

That gate fails until `optimizer/results/frontier_run.json` beats the Codex baseline without
a repair-labeled artifact.

## Contamination Control

Training data uses entity names and held-out concepts that are disjoint from the sealed benchmark tasks. `data/contamination_check.js` must pass before training.

## Ablations

The intended ablation suite compares base, SFT, optimize and repair data, GRPO, LoRA rank, prompt variants, and held-out concept generalization. Results are collected with `eval/aggregate.js` and documented in [docs/ABLATIONS.md](docs/ABLATIONS.md).
