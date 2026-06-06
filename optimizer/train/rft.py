"""forge-optimizer — Stage 2: Rejection Fine-Tuning (RFT), CUDA-Agent-style warm-up.

Between SFT and agentic GRPO, CUDA-Agent does Rejection Fine-Tuning on the model's OWN
high-quality trajectories to establish a strong actor prior and prevent the RL collapse they
saw at ~17 steps (rare-in-pretraining domain). Here:

  1. Sample K solutions per train task from the SFT model (temperature > 0).
  2. Grade each via the forger-bench env (train/agent_env.js) -> milestone reward.
  3. KEEP only outcome-positive trajectories (reward >= 2: correct AND efficient), pattern-
     filtered (valid solve() that compiles). These become the RFT dataset.
  4. Supervised fine-tune the SFT adapter on the kept trajectories.

This is "best-of-K, keep the wins, learn from them" — cheap, stabilizing, and on-policy-ish.

env: FO_INIT_ADAPTER (default train/sft_adapter), FO_RFT_OUT (train/rft_adapter),
     FO_RFT_K (samples/task, default 6), FO_RFT_MIN_REWARD (default 2)
"""
import os, re, json, subprocess, pathlib

import torch
from unsloth import FastLanguageModel
from datasets import Dataset
from trl import SFTTrainer, SFTConfig

_HERE = pathlib.Path(__file__).resolve().parent
_ENV_JS = str(_HERE / "agent_env.js")
_FO_ROOT = str(_HERE.parent)

MODEL = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
INIT = os.getenv("FO_INIT_ADAPTER", "train/sft_adapter")
OUT = os.getenv("FO_RFT_OUT", "train/rft_adapter")
K = int(os.getenv("FO_RFT_K", "6"))
MIN_REWARD = int(os.getenv("FO_RFT_MIN_REWARD", "2"))
MAXLEN = int(os.getenv("FO_MAXLEN", "4096"))
TASKS = os.getenv("FO_GRPO_TASKS", "data/out/grpo_tasks.jsonl")
_CODE_RE = re.compile(r"```(?:js|javascript)?\s*([\s\S]*?)```", re.I)


def extract(t):
    m = list(_CODE_RE.finditer(t or ""))
    if m: return m[-1].group(1).strip()
    i = (t or "").find("async function solve")
    return t[i:].strip() if i != -1 else ""


def grade(task_id, code):
    if not code: return {"reward": -1}
    try:
        p = subprocess.run(["node", _ENV_JS], input=json.dumps({"taskId": task_id, "code": code}),
                           capture_output=True, text=True, timeout=60, cwd=_FO_ROOT)
        if p.returncode != 0 or not p.stdout.strip(): return {"reward": -1}
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return {"reward": -1}


def main():
    model, tok = FastLanguageModel.from_pretrained(
        model_name=INIT if os.path.isdir(INIT) else MODEL, max_seq_length=MAXLEN,
        dtype=torch.bfloat16, load_in_4bit=False, full_finetuning=False)
    FastLanguageModel.for_inference(model)

    tasks = [json.loads(l) for l in open(TASKS, encoding="utf-8") if l.strip()]
    kept = []
    for t in tasks:
        msgs = [{"role": "user", "content": t["prompt"]}]
        ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                      enable_thinking=False, return_tensors="pt").to(model.device)
        # sample K with temperature
        for k in range(K):
            out = model.generate(ids, max_new_tokens=1024, do_sample=True, temperature=0.8, top_p=0.95)
            text = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
            code = extract(text)
            g = grade(t["taskId"], code)
            if g.get("reward", -1) >= MIN_REWARD and code:
                kept.append({"messages": [
                    {"role": "user", "content": t["prompt"]},
                    {"role": "assistant", "content": "```js\n" + code + "\n```"}]})
        print(f"[rft] {t['taskId']}: kept {len(kept)} so far")

    print(f"[rft] {len(kept)} winning trajectories from {len(tasks)} tasks x {K} samples")
    if not kept:
        print("[rft] no winners — skipping RFT (model not yet good enough; go straight to GRPO)")
        return

    # supervised fine-tune on the wins (re-enable training)
    FastLanguageModel.for_training(model)
    ds = Dataset.from_list(kept).map(lambda ex: {"text": tok.apply_chat_template(
        ex["messages"], tokenize=False, add_generation_prompt=False, enable_thinking=False)})
    trainer = SFTTrainer(model=model, tokenizer=tok, train_dataset=ds, args=SFTConfig(
        per_device_train_batch_size=1, gradient_accumulation_steps=8, num_train_epochs=2,
        learning_rate=1e-4, warmup_ratio=0.05, logging_steps=2, optim="adamw_8bit",
        seed=42, output_dir="train/rft_out", report_to="none",
        max_seq_length=MAXLEN, dataset_text_field="text"))
    trainer.train()
    model.save_pretrained(OUT); tok.save_pretrained(OUT)
    print(f"[rft] saved -> {OUT}")


if __name__ == "__main__":
    main()
