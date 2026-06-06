# forge-optimizer — Ablation Results (auto-generated)

| Variant | Pass% | Score | Held-out (top_n,in_list) |
|---|---|---|---|
| A3 +agentic GRPO | 61.5 | 61.5 | 100.0 |
| A2b SFT (all-domain) | 61.5 | 61.5 | 100.0 |

## Frontier baselines (request-cost, sealed test)

| Model | Pass% | Score |
|---|---|---|
| codex | 87.2 | 87.2 |
| claude | 82.1 | 82.1 |
| qwen3.6:latest | 56.4 | 56.3 |

Held-out = mean score on top_n + in_list (concepts NEVER trained on) — measures whether
the model learned optimization vs concept templates.
