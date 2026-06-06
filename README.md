# insforge-hackathon-forger

**FORGER** — benchmark and optimize AI-generated full-stack code before it hits scale.
Built for the InsForge hackathon. Two halves + a live demo:

- **`bench/`** — **forger-bench**: an efficiency-aware benchmark for AI-generated InsForge
  SDK code. Scores correctness AND efficiency, and uniquely **real server cost at 100k-row
  scale**. 52 tasks / 13 concepts / 5 domains. Leaderboard: codex 87, claude 82, gemini/
  gpt-oss/devin 72, nemotron 60, qwen3.6 56, gemma3 5. Headline finding: frontier models
  ship **scaleBugs** (fetch-all code that returns WRONG results at 100k rows due to the
  PostgREST 1000-row cap) and drop from 82-87 to ~54 on the resource axis.
- **`optimizer/`** — **forge-optimizer**: Qwen3.6-35B-A3B (MoE) fine-tuned (Unsloth SFT +
  agentic GRPO, CUDA-Agent-style milestone reward) to turn unoptimized backend code into
  efficient code. Base 56.4 → trained 61.5. Live on HF:
  `squaredcuber/forge-optimizer-qwen3.6-35b-a3b`.
- **`demo_server.js`** + **`bench/site/`** — the live demo: pick a task on the Optimizer
  page → **Claude Haiku 4.5 authors** a solution → **forge-optimizer rewrites** it →
  **forger-bench grades both** → see the before/after, live.

## Run the live demo
```bash
cd bench && npm install && cd ..
# serve the model (on a GPU box) -> optimizer/serve_model.py, expose as FORGE_OPT_URL
ANTHROPIC_API_KEY=sk-... FORGE_OPT_URL=http://<model-host>:8901 node demo_server.js 8900
# open http://localhost:8900  -> Optimizer page -> Run live demo
```
Without `FORGE_OPT_URL` the optimizer step is stubbed (the rest of the demo still runs).

## Run the benchmark
```bash
cd bench
npm run smoke && npm run calibrate && npm run demo      # request-cost
node live/run_resource_bench.js 3 3000                  # resource axis (needs a live InsForge)
```

## Layout
```
bench/        forger-bench (mock, tasks, scoring, live resource bench, runners, site, deck, docs)
optimizer/    forge-optimizer (data gen, SFT/GRPO/RFT, agent_env, eval, serve_model, demo)
demo_server.js   live demo backend wiring Haiku -> forge-optimizer -> forger-bench
```

See `bench/docs/RESULTS.md`, `optimizer/docs/FINAL_SUMMARY.md`, and
`optimizer/docs/ABLATIONS_RESULTS.md` for full results.
