# forge-optimizer — Runtime-bug code review (training scripts)

Scope: `train/sft.py`, `train/grpo.py`, `train/agent_env.js`. Focus on bugs that
only surface at runtime (TRL/Unsloth API drift, reward-fn signature, Node subprocess
contract). Static/style issues are out of scope. Source files were NOT edited.

Reference checks performed:
- forger-bench now lives inside this repository at `bench/`. Optimizer scripts should use
  `FO_FORGER_BENCH` or the local `bench/` default when loading task and harness files.
- `forger-bench/bench/harness.js` exports `gradeSolution(task, code)` and returns
  `{correct, score, eff, perMetric, metrics, error}` — matches every field
  `agent_env.js` reads. **Grader contract is fine.**
- `forger-bench/tasks/index.js` exports `get(id)` — matches `tasks.get(taskId)`. **Fine.**
- Candidate code is compiled via `new Function("...; return solve;")` and must define
  `async function solve(insforge)`; `extract()` returning the fenced block preserves
  that signature. **Fine.**

---

## CRITICAL

### C1. `load_in_16bit=True` is not a real Unsloth arg — model loads in the wrong precision
**Files:** `sft.py:40`, `grpo.py:76`

`FastLanguageModel.from_pretrained` has no `load_in_16bit` parameter. Its precision
knobs are `load_in_4bit`, `load_in_8bit`, `full_finetuning`, and `dtype`. The extra
kwarg is swallowed by `**kwargs` and **silently ignored** — it does not raise, so the
intent ("bf16 16-bit LoRA for MoE") is never enforced. Depending on the Unsloth build,
the default path can still try a 4-bit/bnb route or pick `dtype=None` (auto), which on a
35B-A3B MoE is exactly the case the header comment says must be avoided.

**Fix:** drop `load_in_16bit` and set dtype explicitly.
```python
import torch
model, tok = FastLanguageModel.from_pretrained(
    model_name=MODEL,
    max_seq_length=MAXLEN,
    dtype=torch.bfloat16,     # 16-bit LoRA for MoE
    load_in_4bit=False,
    load_in_8bit=False,
    full_finetuning=False,
)
```

### C2. SFTTrainer `tokenizer=` arg was renamed to `processing_class=`
**File:** `sft.py:65`

Current TRL `SFTTrainer.__init__` no longer accepts `tokenizer=`; it was renamed to
`processing_class=` (the GRPO call at `grpo.py:98` already uses `processing_class=tok`,
so the two scripts are inconsistent). On a current TRL this raises
`TypeError: __init__() got an unexpected keyword argument 'tokenizer'` (or, on a
transitional version, a deprecation that will break shortly).

**Fix:**
```python
trainer = SFTTrainer(
    model=model, processing_class=tok, train_dataset=ds,
    args=SFTConfig(...),
)
```

### C3. GRPO reward fn assumes `kw["task_id"]` is per-completion, but it is per-prompt
**File:** `grpo.py:55-61` (`reward_milestone`)

TRL forwards every non-reserved dataset column to each reward function via `**kwargs`,
but those lists are aligned to the **flattened completions** — i.e. length
`num_prompts * num_generations`, with each prompt's `task_id` repeated `num_generations`
times. That part is actually handled correctly by `zip(task_ids, completions)` **only if**
TRL does the repeat for you (it does in recent versions). The real runtime risk is the
**reserved-name collision and the missing-column case**:

- If the column were named `prompt`/`completion`/`completions` it would be dropped; `task_id`
  is safe, but confirm the dataset column is literally `task_id` (it is, `grpo.py:92`). OK.
- If a future TRL stops auto-broadcasting, `len(kw["task_id"]) == num_prompts` while
  `len(completions) == num_prompts*num_generations`, and `zip` would **silently truncate**
  to the shorter list — graded rewards would be misaligned to completions, poisoning the
  advantage computation with no error. 

**Hardening fix:** guard the alignment instead of trusting it implicitly.
```python
def reward_milestone(prompts, completions, **kw):
    task_ids = kw["task_id"]
    n = len(completions)
    if len(task_ids) != n:                      # broadcast if TRL passed per-prompt
        rep = n // len(task_ids)
        task_ids = [t for t in task_ids for _ in range(rep)]
    out = []
    for tid, comp in zip(task_ids, completions):
        text = comp[0]["content"] if isinstance(comp, list) else comp
        out.append(float(grade(tid, extract(text))["reward"]))
    return out
```

---

## HIGH

### H1. `model.load_adapter()` is the wrong way to resume an Unsloth LoRA for training
**File:** `grpo.py:80-88`

After `from_pretrained` returns a **base** model (no PEFT wrapper yet), calling
`model.load_adapter(INIT_ADAPTER)` either (a) does not exist on the Unsloth-wrapped model
and throws, falling through to the `except` and **silently discarding your SFT prior**
(training "from base + fresh LoRA" — defeating the entire multi-stage warm-up the file's
docstring is built around), or (b) on HF-PEFT models, `load_adapter` loads inference
weights but does **not** make them trainable, so GRPO would update nothing useful.

The supported Unsloth resume path is to pass the saved adapter as `model_name`, or to
`get_peft_model` then load weights. Recommended:
```python
model, tok = FastLanguageModel.from_pretrained(
    model_name=INIT_ADAPTER,        # Unsloth loads base + adapter, trainable
    max_seq_length=MAXLEN, dtype=torch.bfloat16,
    load_in_4bit=False, load_in_8bit=False,
    fast_inference=True,
)
# no get_peft_model needed; adapter is already attached + trainable
```
At minimum, the current `except` clause masking a real failure as "no init adapter" is
dangerous — it converts a hard error into a silent quality regression. Log the exception
type and re-raise unless the adapter dir genuinely does not exist.

### H2. `fast_inference=True` (vLLM) requires GRPO-specific load args that are missing
**File:** `grpo.py:74-78`

Unsloth's vLLM fast-inference path for GRPO generally requires `max_lora_rank` (must be
>= the LoRA `r` you train, here 32) and a `gpu_memory_utilization` to be set at
`from_pretrained` time, plus `use_vllm=True` on `GRPOConfig`. As written, vLLM either
errors at rollout time (LoRA rank exceeds the default `max_lora_rank`) or GRPO falls back
to slow HF generation. Add:
```python
model, tok = FastLanguageModel.from_pretrained(
    ..., fast_inference=True,
    max_lora_rank=32, gpu_memory_utilization=0.85,
)
# GRPOConfig(..., use_vllm=True)
```
(Confirm against the exact installed Unsloth version — these arg names are stable across
recent releases but `use_vllm` lives on the config, not the model.)

---

## MEDIUM

### M1. `subprocess` cwd is implicit — Node grader breaks unless run from forge-optimizer root
**File:** `grpo.py:45-49`

`subprocess.run(["node", os.path.join("train","agent_env.js")], ...)` uses a **relative**
script path and no `cwd=`. It only works if the Python process's CWD is exactly the
`forge-optimizer/` root. Launched from anywhere else (e.g. `train/`), `node train/agent_env.js`
won't find the file and every grade returns `{"reward": -1}` via the `except` — a silent
all-negative reward signal that looks like "the model can't solve anything." Use an
absolute path anchored to the script:
```python
import pathlib
_ENV_JS = str(pathlib.Path(__file__).resolve().parent / "agent_env.js")
...
p = subprocess.run(["node", _ENV_JS], cwd=str(pathlib.Path(__file__).resolve().parent.parent), ...)
```

### M2. Stdout parsing is fragile and swallows the grader's own error channel
**File:** `grpo.py:50`

`json.loads(p.stdout.strip().splitlines()[-1])` will:
- raise `IndexError` on empty stdout (e.g. Node crashes before writing, or writes only to
  stderr) — caught, but reported as a generic reward=-1 with the *Python* exception, hiding
  the real Node error that is sitting in `p.stderr`.
- mis-parse if `agent_env.js` ever prints a non-JSON trailing line (it currently writes a
  single `JSON.stringify` with no newline, so `splitlines()[-1]` works today, but any
  `console.log`/SDK warning to stdout would become "the last line" and break parsing).

**Fix:** check the return code and surface stderr; don't rely on "last line."
```python
if p.returncode != 0 or not p.stdout.strip():
    return {"reward": -1, "correct": False, "error": p.stderr.strip()[:500] or "node failed"}
return json.loads(p.stdout.strip().splitlines()[-1])
```
Also ensure `agent_env.js` never writes diagnostics to stdout (route any logging to
stderr) so stdout stays pure JSON.

### M3. Spawning a fresh `node` process per completion is slow and unbounded
**File:** `grpo.py:45-49`, called once per completion in `reward_milestone`

With `num_generations=8` and a batch, every GRPO step spawns 8 short-lived Node processes,
each `require()`-ing forger-bench and building the cost spread (which itself runs
oracle+naive+mid through fresh backends — several executions per grade). At 60s timeout
each, a single bad batch can stall a step for minutes. Consider a persistent Node worker
(read newline-delimited JSON requests on stdin, write NDJSON responses) or batching all
completions into one `node` invocation. Not a correctness bug, but a throughput cliff that
will look like a hang at scale.

### M4. SFT `enable_thinking=False` passed to `apply_chat_template` may be ignored / error
**File:** `sft.py:58-60`

`enable_thinking` is a Qwen3-template-specific kwarg. If `get_chat_template(tok, "qwen3")`
silently failed (the `try/except: pass` at `sft.py:50-53` hides it) and the tokenizer falls
back to a non-Qwen3 template, `apply_chat_template(..., enable_thinking=False)` may raise
`TypeError` (unexpected kwarg) or be ignored, leaving thinking traces in the SFT targets.
The silent `except: pass` masks which template is actually active. At minimum log on
fallback so you know whether `enable_thinking` is honored.

---

## LOW / CONFIRMED-OK

- `SFTConfig(dataset_text_field="text", max_seq_length=MAXLEN, ...)` — both args still exist
  on current `SFTConfig`. OK. (If you upgrade to a TRL where `max_seq_length` moves, watch
  for it; `dataset_text_field` is stable.)
- `GRPOConfig` args used (`num_generations`, `max_completion_length`, `epsilon`,
  `epsilon_high`, `loss_type`, `max_steps`) are all valid in current TRL GRPO. OK.
- `reward_format` (`grpo.py:64-70`) iterates `completions` directly with no `task_id` zip,
  so it is immune to the C3 alignment risk. OK.
- `agent_env.js` path resolution, grader exports, and return-shape all verified against the
  installed forger-bench. OK.
- `extract()` (`grpo.py:32-37`) preserves the required `async function solve(...)` signature
  that `new Function(...)` in forger-bench needs. OK.

---

## Suggested fix priority
1. **C1** (wrong precision — corrupts the whole run on MoE) and **C2** (hard `TypeError`,
   SFT won't start) — both block the run on a current TRL/Unsloth.
2. **H1** (silently drops the SFT warm-up) — defeats the multi-stage design without erroring.
3. **C3 / M1 / M2** — silent reward-signal corruption (misalignment, wrong CWD, swallowed
   Node errors) that masquerade as "model can't learn."
4. **H2, M3, M4** — perf/robustness.
