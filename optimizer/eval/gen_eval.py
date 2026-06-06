"""forge-optimizer — generate a forger-bench submission from a trained adapter.

Runs the model (base or base+adapter) on the 39 sealed test prompts (greedy, thinking-off —
Qwen3.6 is a thinking model; left on it burns the budget) and writes results/sub_<tag>.json
in forger-bench's submission format. Grade it with forger-bench/bench/eval_submission.js.

The prompts come from forger-bench's shared builder (via a Node dump) so they are
BYTE-IDENTICAL to every other model's prompts — fair comparison.

usage: python eval/gen_eval.py <tag> [adapter_dir]
  tag         : label for the submission (e.g. base, sft, grpo)
  adapter_dir : LoRA adapter to load; omit for the base model
"""
import os, sys, json, subprocess, re

from unsloth import FastLanguageModel

MODEL = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
MAXLEN = int(os.getenv("FO_MAXLEN", "4096"))
FB = os.getenv("FO_FORGER_BENCH", os.path.join("..", "forger-bench"))
_CODE_RE = re.compile(r"```(?:js|javascript)?\s*([\s\S]*?)```", re.I)


def extract(text):
    m = list(_CODE_RE.finditer(text or ""))
    if m:
        return m[-1].group(1).strip()
    i = (text or "").find("async function solve")
    return text[i:].strip() if i != -1 else ""


def test_prompts():
    """Dump the sealed-test prompts from forger-bench's shared builder (byte-identical)."""
    js = ("const t=require('./tasks');const {buildFlatPrompt}=require('./bench/prompt');"
          "process.stdout.write(JSON.stringify(t.TEST.map(x=>({id:x.id,prompt:buildFlatPrompt(x)}))))")
    out = subprocess.run(["node", "-e", js], cwd=FB, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "base"
    adapter = sys.argv[2] if len(sys.argv) > 2 else None

    model, tok = FastLanguageModel.from_pretrained(
        model_name=MODEL, max_seq_length=MAXLEN,
        load_in_4bit=False, load_in_16bit=True, full_finetuning=False)
    if adapter:
        model.load_adapter(adapter); print(f"[eval] loaded adapter {adapter}")
    FastLanguageModel.for_inference(model)

    tasks = test_prompts()
    solutions, ok = {}, 0
    for i, t in enumerate(tasks):
        # Qwen3.6 is multimodal — its chat template expects content as a list of typed parts.
        msgs = [{"role": "user", "content": [{"type": "text", "text": t["prompt"]}]}]
        inputs = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                         enable_thinking=False, return_tensors="pt").to(model.device)
        out = model.generate(inputs, max_new_tokens=1024, do_sample=False,
                             temperature=None, top_p=None, top_k=None)
        text = tok.decode(out[0][inputs.shape[1]:], skip_special_tokens=True)
        code = extract(text)
        if code:
            solutions[t["id"]] = code; ok += 1
        print(f"  [{i+1}/{len(tasks)}] {t['id']:<30} {'ok' if code else 'NO-CODE'}")

    sub = {"model": f"forge-optimizer:{tag}",
           "meta": {"runner": "forge-optimizer", "adapter": adapter, "extracted": ok, "total": len(tasks)},
           "solutions": solutions}
    out_dir = os.path.join(FB, "results")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"sub_fo-{tag}.json")
    json.dump(sub, open(out_path, "w"), indent=2)
    print(f"[eval] wrote {out_path} — {ok}/{len(tasks)} extracted")
    print(f"[eval] grade: node {FB}/bench/eval_submission.js {out_path}")


if __name__ == "__main__":
    main()
