"""forge-optimizer live demo.

An author model writes a backend solution, forge-optimizer rewrites it, and forger-bench
grades both versions.

Run on a box that has node, an Ollama-compatible author endpoint, and the optimizer adapter.

  AUTHOR_URL=http://127.0.0.1:11500 AUTHOR_MODEL=nemotron-3-super:latest python demo/live_demo.py [taskId]
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
FO = HERE.parent
FB = os.getenv("FO_FORGER_BENCH", str(FO.parent / "bench"))
AUTHOR_URL = os.getenv("AUTHOR_URL", "http://127.0.0.1:11500").rstrip("/")
AUTHOR_MODEL = os.getenv("AUTHOR_MODEL", "nemotron-3-super:latest")
_CODE = re.compile(r"```(?:js|javascript)?\s*([\s\S]*?)```", re.I)


def extract(text):
    matches = list(_CODE.finditer(text or ""))
    if matches:
        return matches[-1].group(1).strip()
    idx = (text or "").find("async function solve")
    return text[idx:].strip() if idx != -1 else text


def task_prompt(task_id):
    js = (
        "const t=require('./tasks');const{buildFlatPrompt}=require('./bench/prompt');"
        f"const x=t.get('{task_id}');process.stdout.write(buildFlatPrompt(x))"
    )
    return subprocess.run(
        ["node", "-e", js],
        cwd=FB,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def grade(task_id, code):
    proc = subprocess.run(
        ["node", str(FO / "train" / "agent_env.js")],
        input=json.dumps({"taskId": task_id, "code": code}),
        capture_output=True,
        text=True,
        cwd=str(FO.parent),
        check=True,
    )
    return json.loads(proc.stdout.strip().splitlines()[-1])


def author_once(prompt):
    payload = json.dumps(
        {
            "model": AUTHOR_MODEL,
            "stream": False,
            "think": False,
            "options": {"temperature": 0},
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{AUTHOR_URL}/api/chat",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        body = json.loads(res.read().decode("utf-8"))
    if body.get("error"):
        raise RuntimeError("author model: " + str(body["error"]))
    return body.get("message", {}).get("content", "")


def forge_optimize(prompt, naive_code, model, tokenizer):
    msg = (
        prompt
        + "\n\nHere is an inefficient solution. Rewrite it to be correct and efficient:\n"
        + "```js\n"
        + naive_code
        + "\n```"
    )
    messages = [{"role": "user", "content": [{"type": "text", "text": msg}]}]
    input_ids = tokenizer.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        enable_thinking=False,
        return_tensors="pt",
    ).to(model.device)
    output = model.generate(input_ids, max_new_tokens=1024, do_sample=False)
    return tokenizer.decode(output[0][input_ids.shape[1]:], skip_special_tokens=True)


def banner(title):
    print("\n" + "=" * 70 + f"\n{title}\n" + "=" * 70)


def main():
    task_id = sys.argv[1] if len(sys.argv) > 1 else "db.pagination.test1"
    prompt = task_prompt(task_id)
    banner(f"TASK: {task_id}")
    print(prompt[-400:])

    banner(f"STEP 1: {AUTHOR_MODEL} writes a solution")
    author_raw = author_once(prompt)
    naive = extract(author_raw)
    print(naive)
    before = grade(task_id, naive)
    print(
        f"\n>>> author result: correct={before['correct']} score={before['score']:.0f} "
        f"reward={before['reward']}  {before['obs'][:120]}"
    )

    banner("STEP 2: forge-optimizer rewrites it")
    adapter = os.getenv("FO_ADAPTER", str(FO / "train" / "sft2_adapter"))
    base = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
    import torch
    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=base,
        max_seq_length=4096,
        dtype=torch.bfloat16,
        load_in_4bit=False,
    )
    model.load_adapter(adapter)
    FastLanguageModel.for_inference(model)
    optimized = extract(forge_optimize(prompt, naive, model, tokenizer))
    print(optimized)
    after = grade(task_id, optimized)
    print(
        f"\n>>> forge-optimizer result: correct={after['correct']} score={after['score']:.0f} "
        f"reward={after['reward']}  {after['obs'][:120]}"
    )

    banner("RESULT")
    print(f"  author (before):         score {before['score']:.0f}  correct={before['correct']}")
    print(f"  forge-optimizer (after): score {after['score']:.0f}  correct={after['correct']}")
    print(f"  Improvement: {after['score'] - before['score']:+.0f} points")


if __name__ == "__main__":
    main()
