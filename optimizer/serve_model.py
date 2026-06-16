"""forge-optimizer — minimal OpenAI-compatible inference server (for the live demo).

Serves the trained model behind POST /v1/chat/completions so the demo server (Node) can
call it. Loads base + LoRA adapter once, greedy decode, thinking off.

  FO_BASE_MODEL  base model path   (default /root/models/Qwen3.6-35B-A3B)
  FO_ADAPTER     LoRA adapter dir  (default /root/forge-optimizer/train/sft2_adapter)
  FO_REQUIRE_ADAPTER  fail instead of serving base if adapter is missing (default 0)
  PORT           default 8901
Run: python serve_model.py
"""
import os, re, json

# Unsloth on WSL/Blackwell can reject the default PyTorch allocator config.
# Clear it before importing torch or unsloth so serving works on the rig.
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = ""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from unsloth import FastLanguageModel

BASE = os.getenv("FO_BASE_MODEL", "/root/models/Qwen3.6-35B-A3B")
ADAPTER = os.getenv("FO_ADAPTER", "/root/forge-optimizer/train/sft2_adapter")
REQUIRE_ADAPTER = os.getenv("FO_REQUIRE_ADAPTER", "0").lower() in {"1", "true", "yes", "on"}
PORT = int(os.getenv("PORT", "8901"))

adapter_exists = bool(ADAPTER and os.path.isdir(ADAPTER))
if REQUIRE_ADAPTER and not adapter_exists:
    raise FileNotFoundError(f"FO_ADAPTER does not exist: {ADAPTER}")

# Unsloth PEFT checkpoints must be loaded as the model path. Loading the base first and
# then calling load_adapter can silently miss LoRA keys on Qwen3.6 MoE.
load_path = ADAPTER if adapter_exists else BASE
label = f"{BASE} + {ADAPTER}" if adapter_exists else BASE
print(f"[serve] loading {label} ...")
model, tok = FastLanguageModel.from_pretrained(model_name=load_path, max_seq_length=4096,
                                               dtype=torch.bfloat16, load_in_4bit=False,
                                               full_finetuning=False)
FastLanguageModel.for_inference(model)
print("[serve] model ready")


def generate(user_content, max_new_tokens=768):
    max_new_tokens = max(1, min(int(max_new_tokens or 768), 2048))
    msgs = [{"role": "user", "content": [{"type": "text", "text": user_content}]}]
    ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                  enable_thinking=False, return_tensors="pt").to(model.device)
    out = model.generate(
        ids,
        attention_mask=torch.ones_like(ids),
        max_new_tokens=max_new_tokens,
        do_sample=False,
        pad_token_id=tok.eos_token_id,
    )
    return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or "{}")
        content = body.get("messages", [{}])[-1].get("content", "")
        if isinstance(content, list):
            content = " ".join(c.get("text", "") for c in content)
        text = generate(content, body.get("max_tokens", 768))
        resp = {"choices": [{"message": {"role": "assistant", "content": text}}]}
        data = json.dumps(resp).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*"); self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"status":"ok"}')


if __name__ == "__main__":
    print(f"[serve] http://0.0.0.0:{PORT}/v1/chat/completions")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
