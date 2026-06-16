"""Minimal Modal GPU allocation probe."""

from __future__ import annotations

import json
import os
import pathlib

import modal


ROOT = pathlib.Path(__file__).resolve().parents[1]
GPU = os.environ.get("FORGER_MODAL_GPU", "L40S")

app = modal.App("forger-gpu-probe")
image = modal.Image.from_registry("pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel")


@app.function(image=image, gpu=GPU, timeout=300)
def gpu_probe() -> dict:
    import torch

    out = {
        "gpu_requested": GPU,
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "device_count": torch.cuda.device_count(),
        "devices": [],
    }
    for idx in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(idx)
        out["devices"].append(
            {
                "name": props.name,
                "total_memory_gb": round(props.total_memory / 1024**3, 2),
                "capability": f"{props.major}.{props.minor}",
            }
        )
    if torch.cuda.is_available():
        x = torch.randn((2048, 2048), device="cuda", dtype=torch.float16)
        y = x @ x
        torch.cuda.synchronize()
        out["matmul_checksum"] = float(y[0, 0].detach().cpu())
    return out


@app.local_entrypoint()
def main(out: str = "optimizer/results/modal_probe.json"):
    payload = gpu_probe.remote()
    out_path = pathlib.Path(out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))
    print(f"wrote {out_path}")
