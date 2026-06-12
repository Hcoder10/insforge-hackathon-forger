#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export PYTORCH_CUDA_ALLOC_CONF=""

DATA_N="${FO_DATA_N:-80}"
MODEL_TAG="${FO_MODEL_TAG:-frontier}"
ADAPTER="${FO_ADAPTER:-train/grpo_adapter}"
SCORE_FILE="../bench/results/score_fo-${MODEL_TAG}.json"
SUB_FILE="../bench/results/sub_fo-${MODEL_TAG}.json"
REPAIR="${FO_REPAIR:-0}"

if [[ "${REPAIR,,}" =~ ^(1|true|yes|on)$ ]]; then
  REPORT_MODEL="${FO_REPORT_MODEL:-forge-optimizer-frontier:${MODEL_TAG}-repair-verified}"
  REPORT_STATUS="${FO_REPORT_STATUS:-live-run-repair}"
else
  REPORT_MODEL="${FO_REPORT_MODEL:-forge-optimizer-frontier:${MODEL_TAG}}"
  REPORT_STATUS="${FO_REPORT_STATUS:-live-run}"
fi

node data/gen_data2.js "$DATA_N" data/out
node data/contamination_check.js data/out

python train/sft.py
python train/grpo.py

python eval/gen_eval.py "$MODEL_TAG" "$ADAPTER"
node ../bench/bench/eval_submission.js "$SUB_FILE" "$SCORE_FILE"
node eval/frontier_report.js --score "$SCORE_FILE" --baseline ../bench/results/score_codex.json --out results/frontier_run.json --model "$REPORT_MODEL" --status "$REPORT_STATUS"
node ../tools/forger.js frontier-validate --file results/frontier_run.json
