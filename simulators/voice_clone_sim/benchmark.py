"""
Kaggle GPU VRAM & Voice Cloning Training/Fine-Tuning Experiment Simulator.

Predicts Kaggle T4x2 / P100 / H100 VRAM usage, OOM risk, weekly 30h quota consumption,
and simulates realistic multi-epoch Mel/KL/Flow loss & Speaker Similarity curves.
"""

from __future__ import annotations

import base64
import io
import math
from typing import Any, Dict, List

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from simulators.kaggle_sim.runtime import ACCELERATOR_PROFILES
from .dsp_engine import ARCHITECTURES


def simulate_kaggle_training_experiment(
    architecture_id: str = "qwen_cosyvoice_codec",
    accelerator_id: str = "T4x2",
    finetune_mode: str = "lora",  # "lora" | "full"
    precision: str = "fp16",  # "fp32" | "fp16" | "bf16"
    batch_size: int = 4,
    grad_accum_steps: int = 4,
    max_audio_sec: float = 10.0,
    learning_rate: float = 1e-4,
    epochs: int = 12,
    dataset_hours: float = 2.0,
) -> Dict[str, Any]:
    arch = ARCHITECTURES.get(architecture_id, ARCHITECTURES["qwen_cosyvoice_codec"])
    spec = ACCELERATOR_PROFILES.get(accelerator_id, ACCELERATOR_PROFILES["T4x2"])

    param_millions = {
        "qwen_cosyvoice_codec": 420.0,
        "f5_flow_matching": 335.0,
        "gpt_sovits_fewshot": 195.0,
    }.get(architecture_id, 300.0)

    bytes_per_param = 4.0 if precision == "fp32" else 2.0
    trainable_ratio = 0.045 if finetune_mode == "lora" else 1.0

    weights_gb = (param_millions * 1e6 * bytes_per_param) / (1024**3)
    grads_gb = weights_gb * trainable_ratio
    optim_gb = (param_millions * 1e6 * trainable_ratio * 8.0) / (1024**3)  # AdamW fp32 states
    seq_factor = (max_audio_sec / 8.0) * (arch["sample_rate"] / 24000.0)
    activations_gb = 0.68 * batch_size * seq_factor * (1.0 if precision != "fp32" else 1.75)
    cuda_context_gb = 0.55 if spec.device_count > 0 else 0.0

    per_gpu_batch_div = max(1, spec.device_count) if batch_size >= spec.device_count and spec.device_count > 1 else 1
    peak_vram_per_gpu_gb = round(
        weights_gb + grads_gb + optim_gb + (activations_gb / per_gpu_batch_div) + cuda_context_gb,
        2,
    )
    gpu_limit_gb = round(spec.vram_mib_per_gpu / 1024.0, 2)
    oom_risk = spec.device_count > 0 and peak_vram_per_gpu_gb > (gpu_limit_gb * 0.96)
    bf16_warning = precision == "bf16" and spec.compute_capability[0] < 8 and spec.device_count > 0

    # Throughput & Kaggle 30h quota estimation
    total_utterances = max(20, int((dataset_hours * 3600.0) / max(2.0, max_audio_sec * 0.65)))
    steps_per_epoch = max(1, math.ceil(total_utterances / max(1, batch_size)))
    total_steps = steps_per_epoch * epochs
    effective_tflops = max(0.8, spec.fp16_tflops * max(1, spec.device_count))
    step_time_sec = round((0.42 * batch_size * seq_factor * (65.0 / effective_tflops)) * (1.6 if finetune_mode == "full" else 1.0), 3)
    est_train_minutes = round((total_steps * step_time_sec) / 60.0, 1)
    kaggle_quota_pct = round((est_train_minutes / 60.0) / 30.0 * 100.0, 2)

    # Simulate epoch convergence metrics
    rng = np.random.default_rng(int(learning_rate * 1e7) + epochs + batch_size)
    lr_opt_factor = math.exp(-abs(math.log10(max(learning_rate, 1e-7)) - (-4.0)) * 0.35)
    history: List[Dict[str, Any]] = []
    for ep in range(1, epochs + 1):
        progress = ep / max(1, epochs)
        decay = math.exp(-2.3 * progress * lr_opt_factor)
        mel_loss = round(float(2.85 * decay + 0.52 + rng.normal(0, 0.025)), 4)
        kl_loss = round(float(1.45 * decay + 0.21 + rng.normal(0, 0.015)), 4)
        val_secs = round(float(min(0.945, 0.64 + 0.28 * (1.0 - decay) + rng.normal(0, 0.006))), 4)
        val_mcd = round(float(max(3.65, 7.8 * decay + 3.85 + rng.normal(0, 0.06))), 3)
        history.append(
            {
                "epoch": ep,
                "step": ep * steps_per_epoch,
                "mel_loss": mel_loss,
                "kl_loss": kl_loss,
                "val_secs": val_secs,
                "val_mcd_db": val_mcd,
            }
        )

    # Render training curves chart
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(8.8, 3.2), constrained_layout=True)
    fig.patch.set_facecolor("#0f172a")
    eps = [h["epoch"] for h in history]
    for ax in (ax1, ax2):
        ax.set_facecolor("#1e293b")
        ax.tick_params(colors="#94a3b8", labelsize=8)
        for sp in ax.spines.values():
            sp.set_color("#334155")

    ax1.plot(eps, [h["mel_loss"] for h in history], "-o", color="#f43f5e", markersize=4, label="Mel Loss")
    ax1.plot(eps, [h["kl_loss"] for h in history], "-s", color="#fb923c", markersize=4, label="KL/Align Loss")
    ax1.set_title("Simulated Training Loss", color="#e2e8f0", fontsize=10)
    ax1.set_xlabel("Epoch", color="#94a3b8", fontsize=8)
    ax1.legend(facecolor="#0f172a", labelcolor="#e2e8f0", fontsize=8)

    ax2.plot(eps, [h["val_secs"] for h in history], "-o", color="#34d399", markersize=4, label="Val SECS (↑)")
    ax2.set_title("Validation Speaker Similarity (SECS)", color="#e2e8f0", fontsize=10)
    ax2.set_xlabel("Epoch", color="#94a3b8", fontsize=8)
    ax2.set_ylim(0.55, 1.0)
    ax2.legend(facecolor="#0f172a", labelcolor="#e2e8f0", fontsize=8)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110)
    plt.close(fig)

    recommendations: List[str] = []
    if oom_risk:
        recommendations.append(
            f"⚠️ 显存溢出风险：预估单卡峰值 {peak_vram_per_gpu_gb} GB 超过 {spec.gpu_name} 上限 ({gpu_limit_gb} GB)！建议将 batch_size 调低或启用 LoRA + fp16。"
        )
    else:
        recommendations.append(
            f"✅ 显存安全：单卡峰值 {peak_vram_per_gpu_gb} GB / {gpu_limit_gb} GB，可在 {spec.label} 稳定运行。"
        )
    if bf16_warning:
        recommendations.append(
            f"⚠️ Kaggle {spec.gpu_name} (Compute {spec.compute_capability[0]}.{spec.compute_capability[1]}) 原生不支持硬件 bf16 TensorCore，建议改用 fp16 以避免降速。"
        )
    if spec.id == "T4x2" and batch_size >= 2:
        recommendations.append("💡 Kaggle T4 x2 双卡提示：可使用 `torch.nn.DataParallel` 或 `accelerate launch --num_processes=2` 吞吐翻倍。")

    return {
        "config": {
            "architecture": arch["name"],
            "architecture_id": architecture_id,
            "accelerator": spec.label,
            "accelerator_id": spec.id,
            "finetune_mode": finetune_mode,
            "precision": precision,
            "batch_size": batch_size,
            "grad_accum_steps": grad_accum_steps,
            "effective_batch_size": batch_size * grad_accum_steps,
            "max_audio_sec": max_audio_sec,
            "learning_rate": learning_rate,
            "epochs": epochs,
            "dataset_hours": dataset_hours,
        },
        "vram_breakdown_gb": {
            "weights_gb": round(weights_gb, 2),
            "gradients_gb": round(grads_gb, 2),
            "optimizer_gb": round(optim_gb, 2),
            "activations_per_gpu_gb": round(activations_gb / per_gpu_batch_div, 2),
            "peak_per_gpu_gb": peak_vram_per_gpu_gb,
            "gpu_limit_gb": gpu_limit_gb,
            "oom_risk": oom_risk,
        },
        "schedule": {
            "total_utterances": total_utterances,
            "steps_per_epoch": steps_per_epoch,
            "total_steps": total_steps,
            "est_train_minutes": est_train_minutes,
            "kaggle_weekly_30h_quota_pct": kaggle_quota_pct,
        },
        "final_metrics": history[-1],
        "history": history,
        "recommendations": recommendations,
        "plot_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
    }
