"""forge-optimizer — Stage 1: SFT with Unsloth on Qwen3.6-35B-A3B (MoE).

Teaches the optimization patterns (author + optimize + repair modes) from the
contamination-free synth data. MoE caveat (Unsloth docs): bf16 16-bit LoRA, NOT QLoRA
4-bit (BitsandBytes can't do MoE 4-bit). 35B-A3B bf16 LoRA ~74GB -> fits the 96GB Blackwell.

Establishes the behavioral prior before RFT + agentic GRPO (multi-stage warm-up prevents
the RL collapse CUDA-Agent documented at ~17 steps for rare-in-pretraining domains).

env:
  FO_SFT_DATA   path to sft.jsonl (messages format)        default data/out/sft.jsonl
  FO_SFT_OUT    adapter output dir                          default train/sft_adapter
  FO_EPOCHS     epochs                                      default 2
  FO_LORA_R     LoRA rank                                   default 32
  FO_LORA_ALPHA LoRA alpha                                  default 64
  FO_MAXLEN     max seq length                              default 4096
"""
import os, json

# Unsloth on WSL/Blackwell can reject the default PyTorch allocator config.
# Clear it before importing torch or unsloth so the rig run is reproducible.
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = ""

import torch
from unsloth import FastLanguageModel
from unsloth.chat_templates import get_chat_template
from datasets import Dataset
from trl import SFTTrainer, SFTConfig

MODEL = os.getenv("FO_BASE_MODEL", "unsloth/Qwen3.6-35B-A3B")
DATA = os.getenv("FO_SFT_DATA", "data/out/sft.jsonl")
OUT = os.getenv("FO_SFT_OUT", "train/sft_adapter")
EPOCHS = float(os.getenv("FO_EPOCHS", "2"))
LORA_R = int(os.getenv("FO_LORA_R", "32"))
LORA_ALPHA = int(os.getenv("FO_LORA_ALPHA", "64"))
MAXLEN = int(os.getenv("FO_MAXLEN", "4096"))


def main():
    model, tok = FastLanguageModel.from_pretrained(
        model_name=MODEL,
        max_seq_length=MAXLEN,
        dtype=torch.bfloat16,
        load_in_4bit=False,        # MoE: NEVER 4-bit (BitsandBytes limitation)
        full_finetuning=False,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=0.0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )
    try:
        tok = get_chat_template(tok, chat_template="qwen3")
    except Exception:
        pass  # fall back to the model's built-in template

    # load messages-format JSONL -> rendered text
    rows = [json.loads(l) for l in open(DATA, encoding="utf-8") if l.strip()]
    def render(ex):
        return {"text": tok.apply_chat_template(ex["messages"], tokenize=False,
                                                add_generation_prompt=False,
                                                enable_thinking=False)}
    ds = Dataset.from_list(rows).map(render)
    print(f"[sft] {len(ds)} examples; sample chars={len(ds[0]['text'])}")

    trainer = SFTTrainer(
        model=model, tokenizer=tok, train_dataset=ds,
        args=SFTConfig(
            per_device_train_batch_size=1, gradient_accumulation_steps=8,
            warmup_ratio=0.05, num_train_epochs=EPOCHS,
            learning_rate=2e-4, logging_steps=5,
            optim="adamw_8bit", weight_decay=0.01, lr_scheduler_type="linear",
            seed=42, output_dir="train/sft_out", report_to="none",
            max_seq_length=MAXLEN, dataset_text_field="text",
        ),
    )
    trainer.train()
    model.save_pretrained(OUT)
    tok.save_pretrained(OUT)
    print(f"[sft] saved adapter -> {OUT}")


if __name__ == "__main__":
    main()
