"""forge-optimizer — Stage 3: agentic GRPO with Unsloth (CUDA-Agent-style).

The model generates a solution for a backend task; the forger-bench grader (via Node
train/agent_env.js) RUNS it, checks correctness incl. the 100k-row scaleBug trap, measures
server cost, and returns the discrete MILESTONE reward (-1/1/2/3) — CUDA-Agent's top ablation
finding (discrete >> continuous speedup reward). vLLM fast_inference for rollouts.

Starts from the RFT/SFT adapter (multi-stage warm-up prevents RL collapse). Trains ONLY on
train-split + freshly-synthesized tasks (never the sealed test) -> no contamination.

Reward functions (Unsloth/TRL: each gets prompts+completions, returns list[float]):
  reward_milestone  : the -1/1/2/3 grade from agent_env (correctness + efficiency + anti-hack)
  reward_format     : small bonus for emitting a single clean ```js solve() block

env: FO_GRPO_STEPS (default 200), FO_INIT_ADAPTER (default train/sft_adapter)
"""
import os, re, json, subprocess, pathlib

# Unsloth on WSL/Blackwell can reject the default PyTorch allocator config.
# Clear it before importing torch or unsloth so the rig run is reproducible.
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = ""

import torch
from unsloth import FastLanguageModel
from datasets import Dataset
from trl import GRPOConfig, GRPOTrainer

# Absolute paths so the Node reward grader works regardless of CWD (code review M1).
_HERE = pathlib.Path(__file__).resolve().parent
_ENV_JS = str(_HERE / "agent_env.js")
_WORKER_JS = str(_HERE / "grader_worker.js")
_FO_ROOT = str(_HERE.parent)

# Persistent grader worker: one long-lived Node process (avoids per-completion startup +
# forger-bench require on every grade — code review M3). Falls back to per-call if it dies.
import threading
_worker = None
_worker_lock = threading.Lock()
_req_id = 0


def _ensure_worker():
    global _worker
    if _worker is None or _worker.poll() is not None:
        _worker = subprocess.Popen(["node", _WORKER_JS], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, text=True, cwd=_FO_ROOT, bufsize=1)
    return _worker


def grade_worker(task_id, code):
    global _req_id
    if not code:
        return {"reward": -1, "correct": False}
    with _worker_lock:
        try:
            w = _ensure_worker()
            _req_id += 1
            w.stdin.write(json.dumps({"id": _req_id, "taskId": task_id, "code": code}) + "\n")
            w.stdin.flush()
            line = w.stdout.readline()
            return json.loads(line) if line.strip() else {"reward": -1, "correct": False}
        except Exception as e:
            return {"reward": -1, "correct": False, "error": str(e)}

MODEL = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
INIT_ADAPTER = os.getenv("FO_INIT_ADAPTER", "train/sft_adapter")
STEPS = int(os.getenv("FO_GRPO_STEPS", "200"))
MAXLEN = int(os.getenv("FO_MAXLEN", "4096"))
TRAIN_TASKS = os.getenv("FO_GRPO_TASKS", "data/out/grpo_tasks.jsonl")  # {taskId, prompt}

_CODE_RE = re.compile(r"```(?:js|javascript)?\s*([\s\S]*?)```", re.I)


def extract(text):
    m = list(_CODE_RE.finditer(text or ""))
    if m:
        return m[-1].group(1).strip()
    i = (text or "").find("async function solve")
    return text[i:].strip() if i != -1 else ""


def grade(task_id, code):
    """Call the Node agent_env grader; return its milestone reward + correctness.
    Absolute paths + explicit cwd (M1); surface stderr instead of swallowing it (M2)."""
    if not code:
        return {"reward": -1, "correct": False}
    try:
        p = subprocess.run(
            ["node", _ENV_JS],
            input=json.dumps({"taskId": task_id, "code": code}),
            capture_output=True, text=True, timeout=60, cwd=_FO_ROOT,
        )
        if p.returncode != 0 or not p.stdout.strip():
            return {"reward": -1, "correct": False, "error": (p.stderr or "node failed")[:300]}
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"reward": -1, "correct": False, "error": str(e)}


def reward_milestone(prompts, completions, **kw):
    task_ids = kw["task_id"]
    # Guard alignment: if TRL passed per-prompt task_ids, broadcast to per-completion (C3).
    if len(task_ids) != len(completions) and len(task_ids):
        rep = len(completions) // len(task_ids)
        task_ids = [t for t in task_ids for _ in range(max(rep, 1))]
    out = []
    for tid, comp in zip(task_ids, completions):
        text = comp[0]["content"] if isinstance(comp, list) else comp
        out.append(float(grade_worker(tid, extract(text))["reward"]))
    return out


def reward_format(prompts, completions, **kw):
    out = []
    for comp in completions:
        text = comp[0]["content"] if isinstance(comp, list) else comp
        blocks = _CODE_RE.findall(text or "")
        out.append(0.5 if (len(blocks) == 1 and "solve" in blocks[0]) else 0.0)
    return out


def main():
    # Resume the SFT/RFT adapter as a TRAINABLE policy by loading it as model_name (H1).
    # If no adapter exists, load the base and attach a fresh LoRA.
    init = INIT_ADAPTER if os.path.isdir(INIT_ADAPTER) else MODEL
    model, tok = FastLanguageModel.from_pretrained(
        model_name=init, max_seq_length=MAXLEN,
        dtype=torch.bfloat16, load_in_4bit=False, full_finetuning=False,  # MoE: bf16 (C1)
        # NOTE: Unsloth vLLM fast_inference does NOT support this multimodal MoE arch
        # (siglip + qwen3_5_moe vision tower) — fall back to HF generation for rollouts.
    )
    if init == MODEL:
        print("[grpo] no SFT adapter found; attaching fresh LoRA on base")
        model = FastLanguageModel.get_peft_model(
            model, r=32, lora_alpha=64,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            use_gradient_checkpointing="unsloth")
    else:
        print(f"[grpo] resumed trainable adapter from {init}")

    rows = [json.loads(l) for l in open(TRAIN_TASKS, encoding="utf-8") if l.strip()]
    ds = Dataset.from_list([
        {"prompt": [{"role": "user", "content": [{"type": "text", "text": r["prompt"]}]}], "task_id": r["taskId"]}
        for r in rows
    ])
    print(f"[grpo] {len(ds)} train tasks")

    trainer = GRPOTrainer(
        model=model, processing_class=tok,
        reward_funcs=[reward_milestone, reward_format],
        args=GRPOConfig(
            learning_rate=5e-6, per_device_train_batch_size=1, gradient_accumulation_steps=4,
            num_generations=4, max_completion_length=1024, max_steps=STEPS,
            epsilon=0.2, epsilon_high=0.28,           # CUDA-Agent stable asymmetric clip
            loss_type="grpo", logging_steps=2, save_steps=40, use_vllm=False,
            output_dir="train/grpo_out", report_to="none",
        ),
        train_dataset=ds,
    )
    trainer.train()
    model.save_pretrained("train/grpo_adapter")
    tok.save_pretrained("train/grpo_adapter")
    print("[grpo] saved -> train/grpo_adapter")


if __name__ == "__main__":
    main()
