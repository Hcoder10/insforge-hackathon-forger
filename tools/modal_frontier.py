"""Modal GPU runner for FORGER frontier jobs.

Usage:
  modal run tools/modal_frontier.py::probe
  modal run tools/modal_frontier.py::frontier --data-n 120 --steps 120 --epochs 1

Set FORGER_MODAL_GPU before running to choose hardware:
  PowerShell: $env:FORGER_MODAL_GPU="A100-80GB"
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time

import modal


ROOT = pathlib.Path(__file__).resolve().parents[1]
GPU = os.environ.get("FORGER_MODAL_GPU", "L40S")
TRAIN_GPU = os.environ.get("FORGER_MODAL_TRAIN_GPU", GPU)
HF_SECRET = os.environ.get("FORGER_MODAL_HF_SECRET", "huggingface")

app = modal.App("forger-frontier")
hf_cache = modal.Volume.from_name("forger-hf-cache", create_if_missing=True)


def ignore_repo_path(path: pathlib.Path) -> bool:
    parts = set(path.parts)
    if ".git" in parts or "node_modules" in parts or "__pycache__" in parts:
        return True
    rel = path.as_posix()
    return any(
        token in rel
        for token in (
            "optimizer/train/grpo_adapter/",
            "optimizer/train/sft_adapter/",
            "optimizer/train/rft_adapter/",
            "optimizer/train/grpo_out/",
            "optimizer/train/sft_out/",
            "optimizer/train/rft_out/",
            "optimizer/data/out/",
            "optimizer/data/out2/",
            "bench/site/qa/",
            "bench/site/qa-refined/",
        )
    ) or rel.endswith(".pyc")


probe_image = modal.Image.from_registry(
    "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel",
).apt_install("git")

train_image = (
    probe_image.apt_install("bash", "curl", "git", "nodejs")
    .pip_install(
        "accelerate",
        "bitsandbytes",
        "datasets==4.3.0",
        "hf_transfer",
        "peft",
        "sentencepiece",
        "transformers==5.5.0",
        "trl",
        "unsloth==2026.6.7",
        "unsloth_zoo==2026.6.5",
    )
    .add_local_dir(ROOT, remote_path="/root/forger", copy=True, ignore=ignore_repo_path)
)


@app.function(
    image=probe_image,
    gpu=GPU,
    timeout=300,
    secrets=[modal.Secret.from_name(HF_SECRET)],
)
def gpu_probe() -> dict:
    import torch

    payload = {
        "gpu_requested": GPU,
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "device_count": torch.cuda.device_count(),
        "devices": [],
    }
    for idx in range(torch.cuda.device_count()):
        props = torch.cuda.get_device_properties(idx)
        payload["devices"].append(
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
        payload["matmul_checksum"] = float(y[0, 0].detach().cpu())
    return payload


def stream(cmd: list[str], cwd: str, env: dict[str, str]) -> str:
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
    )
    lines: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end="", flush=True)
        lines.append(line)
        if len(lines) > 1200:
            lines = lines[-1200:]
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed with exit code {code}\n{''.join(lines[-80:])}")
    return "".join(lines)


@app.function(
    image=train_image,
    gpu=TRAIN_GPU,
    timeout=60 * 60 * 5,
    startup_timeout=60 * 30,
    secrets=[modal.Secret.from_name(HF_SECRET)],
    volumes={
        "/root/.cache/huggingface": hf_cache,
    },
)
def frontier_job(
    data_n: int = 120,
    steps: int = 120,
    epochs: float = 1.0,
    lora_r: int = 32,
    maxlen: int = 4096,
    num_generations: int = 4,
    max_completion: int = 1024,
    grad_accum: int = 4,
    save_steps: int = 40,
    tag: str = "modal-frontier",
    repair: bool = False,
) -> dict:
    env = os.environ.copy()
    env.update(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "LD_LIBRARY_PATH": "/opt/conda/lib/python3.11/site-packages/nvidia/nvjitlink/lib:"
            "/opt/conda/lib/python3.11/site-packages/nvidia/cublas/lib:"
            + env.get("LD_LIBRARY_PATH", ""),
            "PYTORCH_CUDA_ALLOC_CONF": "",
            "FO_DATA_N": str(data_n),
            "FO_MODEL_TAG": tag,
            "FO_GRPO_STEPS": str(steps),
            "FO_EPOCHS": str(epochs),
            "FO_LORA_R": str(lora_r),
            "FO_LORA_ALPHA": str(lora_r * 2),
            "FO_MAXLEN": str(maxlen),
            "FO_NUM_GENERATIONS": str(num_generations),
            "FO_MAX_COMPLETION": str(max_completion),
            "FO_GRAD_ACCUM": str(grad_accum),
            "FO_SAVE_STEPS": str(save_steps),
            "FO_DISABLE_COMPILE": "1",
            "FO_REPAIR": "1" if repair else "0",
            "FO_REPORT_MODEL": f"forge-optimizer-frontier:{tag}-modal{'-repair' if repair else '-raw'}",
            "FO_REPORT_STATUS": "live-run-repair-modal" if repair else "live-run-raw-modal",
        }
    )
    started = time.time()
    candidates = ["/root/forger/optimizer", "/optimizer"]
    cwd = next((p for p in candidates if pathlib.Path(p, "train", "sft.py").exists()), None)
    if not cwd:
        found = subprocess.run(
            ["bash", "-lc", "find / -path '*/optimizer/train/sft.py' -print -quit 2>/dev/null"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
        if found:
            cwd = str(pathlib.Path(found).parents[1])
    if not cwd:
        listing = subprocess.run(["bash", "-lc", "ls -la / /root 2>/dev/null"], capture_output=True, text=True, timeout=30).stdout
        raise RuntimeError(f"could not find optimizer checkout; checked {candidates}\n{listing}")
    log = stream(["bash", "scripts/frontier_run.sh"], cwd=cwd, env=env)

    paths = {
        "frontier": str(pathlib.Path(cwd) / "results" / "frontier_run.json"),
        "score": str(pathlib.Path(cwd).parent / "bench" / "results" / f"score_fo-{tag}.json"),
        "submission": str(pathlib.Path(cwd).parent / "bench" / "results" / f"sub_fo-{tag}.json"),
    }
    artifacts: dict[str, str] = {}
    for name, file in paths.items():
        p = pathlib.Path(file)
        if p.exists():
            artifacts[name] = p.read_text(encoding="utf-8")
    return {
        "gpu_requested": TRAIN_GPU,
        "tag": tag,
        "repair": repair,
        "seconds": round(time.time() - started, 1),
        "artifacts": artifacts,
        "log_tail": "\n".join(log.splitlines()[-120:]),
    }


@app.local_entrypoint()
def probe():
    print(json.dumps(gpu_probe.remote(), indent=2))


@app.local_entrypoint()
def frontier(
    data_n: int = 120,
    steps: int = 120,
    epochs: float = 1.0,
    lora_r: int = 32,
    maxlen: int = 4096,
    num_generations: int = 4,
    max_completion: int = 1024,
    grad_accum: int = 4,
    save_steps: int = 40,
    tag: str = "modal-frontier",
    repair: bool = False,
    out_dir: str = "optimizer/results/modal",
):
    result = frontier_job.remote(
        data_n=data_n,
        steps=steps,
        epochs=epochs,
        lora_r=lora_r,
        maxlen=maxlen,
        num_generations=num_generations,
        max_completion=max_completion,
        grad_accum=grad_accum,
        save_steps=save_steps,
        tag=tag,
        repair=repair,
    )
    out = ROOT / out_dir
    out.mkdir(parents=True, exist_ok=True)
    (out / "modal_run.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for name, text in result.get("artifacts", {}).items():
        (out / f"{name}.json").write_text(text, encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "artifacts"}, indent=2))
    print(f"wrote {out}")
