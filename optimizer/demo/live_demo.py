"""forge-optimizer — LIVE DEMO: Haiku writes naive code -> our model optimizes -> benchmark proves it.

The money shot: a frontier model (Claude Haiku 4.5) writes a plausible backend solution that
looks right but is wasteful / wrong-at-scale; forge-optimizer rewrites it efficient + correct;
forger-bench grades BOTH and shows the improvement (score up, scaleBug gone).

Run on a box that has the served forge-optimizer model + node + the ANTHROPIC_API_KEY.
  ANTHROPIC_API_KEY=... python demo/live_demo.py [taskId]

Flow per task:
  1. Build the task prompt (from forger-bench).
  2. Haiku 4.5 authors a solution (the realistic "before").
  3. forge-optimizer takes Haiku's code + the task -> optimized "after".
  4. forger-bench grades both -> print before/after score, correctness, scaleBug, server cost.
"""
import os, re, sys, json, subprocess, pathlib

HERE = pathlib.Path(__file__).resolve().parent
FO = HERE.parent
FB = os.getenv("FO_FORGER_BENCH", str(FO.parent / "forger-bench"))
_CODE = re.compile(r"```(?:js|javascript)?\s*([\s\S]*?)```", re.I)


def extract(t):
    m = list(_CODE.finditer(t or ""))
    if m: return m[-1].group(1).strip()
    i = (t or "").find("async function solve")
    return t[i:].strip() if i != -1 else t


def task_prompt(task_id):
    js = (f"const t=require('./tasks');const{{buildFlatPrompt}}=require('./bench/prompt');"
          f"const x=t.get('{task_id}');process.stdout.write(buildFlatPrompt(x))")
    return subprocess.run(["node", "-e", js], cwd=FB, capture_output=True, text=True, check=True).stdout


def grade(task_id, code):
    p = subprocess.run(["node", str(FO / "train" / "agent_env.js")],
                       input=json.dumps({"taskId": task_id, "code": code}),
                       capture_output=True, text=True, cwd=str(FO))
    return json.loads(p.stdout.strip().splitlines()[-1])


def haiku_author(prompt):
    from anthropic import Anthropic
    c = Anthropic()
    r = c.messages.create(model="claude-haiku-4-5-20251001", max_tokens=1024,
                          messages=[{"role": "user", "content": prompt}])
    return r.content[0].text


def forge_optimize(prompt, naive_code, model, tok):
    from unsloth import FastLanguageModel
    msg = prompt + f"\n\nHere is an inefficient solution — rewrite it to be correct and efficient:\n```js\n{naive_code}\n```"
    msgs = [{"role": "user", "content": [{"type": "text", "text": msg}]}]
    ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                  enable_thinking=False, return_tensors="pt").to(model.device)
    out = model.generate(ids, max_new_tokens=1024, do_sample=False)
    return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)


def banner(t): print("\n" + "=" * 70 + f"\n{t}\n" + "=" * 70)


def main():
    task_id = sys.argv[1] if len(sys.argv) > 1 else "db.pagination.test1"
    prompt = task_prompt(task_id)
    banner(f"TASK: {task_id}")
    print(prompt[-400:])

    banner("STEP 1 — Claude Haiku 4.5 writes a solution (the realistic 'before')")
    haiku_raw = haiku_author(prompt)
    naive = extract(haiku_raw)
    print(naive)
    g_before = grade(task_id, naive)
    print(f"\n>>> Haiku result: correct={g_before['correct']} score={g_before['score']:.0f} "
          f"reward={g_before['reward']}  {g_before['obs'][:120]}")

    banner("STEP 2 — forge-optimizer rewrites it (the 'after')")
    adapter = os.getenv("FO_ADAPTER", str(FO / "train" / "sft2_adapter"))
    base = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
    from unsloth import FastLanguageModel
    model, tok = FastLanguageModel.from_pretrained(model_name=base, max_seq_length=4096,
                                                   dtype=__import__("torch").bfloat16, load_in_4bit=False)
    model.load_adapter(adapter)
    FastLanguageModel.for_inference(model)
    opt = extract(forge_optimize(prompt, naive, model, tok))
    print(opt)
    g_after = grade(task_id, opt)
    print(f"\n>>> forge-optimizer result: correct={g_after['correct']} score={g_after['score']:.0f} "
          f"reward={g_after['reward']}  {g_after['obs'][:120]}")

    banner("RESULT")
    print(f"  Haiku (before):          score {g_before['score']:.0f}  correct={g_before['correct']}")
    print(f"  forge-optimizer (after): score {g_after['score']:.0f}  correct={g_after['correct']}")
    print(f"  Improvement: {g_after['score'] - g_before['score']:+.0f} points")


if __name__ == "__main__":
    main()
