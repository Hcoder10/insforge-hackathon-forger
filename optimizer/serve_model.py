"""forge-optimizer — minimal OpenAI-compatible inference server (for the live demo).

Serves the trained model behind POST /v1/chat/completions so the demo server (Node) can
call it. Loads base + LoRA adapter once, greedy decode, thinking off.

  FO_BASE_MODEL  base model path   (default /root/models/Qwen3.6-35B-A3B)
  FO_ADAPTER     LoRA adapter dir  (default /root/forge-optimizer/train/sft2_adapter)
  PORT           default 8901
Run: python serve_model.py
"""
import os, re, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from unsloth import FastLanguageModel

BASE = os.getenv("FO_BASE_MODEL", "/root/models/Qwen3.6-35B-A3B")
ADAPTER = os.getenv("FO_ADAPTER", "/root/forge-optimizer/train/sft2_adapter")
PORT = int(os.getenv("PORT", "8901"))

print(f"[serve] loading {BASE} + {ADAPTER} ...")
model, tok = FastLanguageModel.from_pretrained(model_name=BASE, max_seq_length=4096,
                                               dtype=torch.bfloat16, load_in_4bit=False)
model.load_adapter(ADAPTER)
FastLanguageModel.for_inference(model)
print("[serve] model ready")


def generate(user_content):
    msgs = [{"role": "user", "content": [{"type": "text", "text": user_content}]}]
    ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                  enable_thinking=False, return_tensors="pt").to(model.device)
    out = model.generate(ids, max_new_tokens=768, do_sample=False)
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
        text = generate(content)
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
