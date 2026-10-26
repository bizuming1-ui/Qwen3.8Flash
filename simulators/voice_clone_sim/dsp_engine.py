"""
Real Signal-Processing Voice Cloning & Acoustic Analysis Simulator.

Provides:
1. Synthetic formant-harmonic reference speech dataset generator (`/kaggle/input/sample-voice-dataset`)
2. Acoustic analysis (VAD, F0 pitch contour, 80-band Mel spectrogram, 256-dim speaker embedding)
3. End-to-end Voice Cloning simulation across 3 mainstream TTS/VC architectures with real playable WAV
   output, Mel/F0 comparison plots, SECS (Speaker Cosine Similarity), MCD (dB), and RTF metrics.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import math
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import librosa
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf
from scipy import signal

from simulators.kaggle_sim.runtime import PROJECT_ROOT, get_kaggle_runtime


ARCHITECTURES: Dict[str, Dict[str, Any]] = {
    "qwen_cosyvoice_codec": {
        "id": "qwen_cosyvoice_codec",
        "name": "Zero-Shot Neural Codec LLM (Qwen-TTS / CosyVoice 风格)",
        "plot_title": "Zero-Shot Neural Codec LLM (Qwen-TTS / CosyVoice)",
        "sample_rate": 24000,
        "n_mels": 80,
        "stages": [
            "1. Reference VAD & Resampling (24kHz)",
            "2. CampPlus / ECAPA-TDNN Speaker Embedding (256-d)",
            "3. Speech Tokenizer -> Discrete Semantic Tokens (25Hz)",
            "4. Autoregressive LLM Token Generation",
            "5. Conditional Flow-Matching Mel Decoder + HiFi-GAN Vocoder",
        ],
        "base_vram_gb": 4.8,
        "noise_floor": 0.004,
    },
    "f5_flow_matching": {
        "id": "f5_flow_matching",
        "name": "Zero-Shot Flow-Matching DiT (F5-TTS / E2-TTS 风格)",
        "plot_title": "Zero-Shot Flow-Matching DiT (F5-TTS / E2-TTS)",
        "sample_rate": 24000,
        "n_mels": 100,
        "stages": [
            "1. Reference Audio + Transcript Alignment",
            "2. 100-Band Log-Mel Spectrogram Extraction",
            "3. ConvNeXt V2 Text-Acoustic Prefix Conditioning",
            "4. DiT Optimal-Transport ODE Solver (Sway Sampling)",
            "5. Vocos Spectral ISTFT Vocoder",
        ],
        "base_vram_gb": 3.6,
        "noise_floor": 0.003,
    },
    "gpt_sovits_fewshot": {
        "id": "gpt_sovits_fewshot",
        "name": "Few-Shot Semantic-VITS (GPT-SoVITS / VITS2 风格)",
        "plot_title": "Few-Shot Semantic-VITS (GPT-SoVITS / VITS2)",
        "sample_rate": 32000,
        "n_mels": 80,
        "stages": [
            "1. Reference Audio Slicing & Loudness Normalization",
            "2. CN-HuBERT SSL Soft Content Feature Extraction",
            "3. AR GPT Semantic Token Predictor",
            "4. SoVITS Variational Acoustic & Pitch Decoder",
            "5. NSF-HiFiGAN Neural Source-Filter Vocoder",
        ],
        "base_vram_gb": 5.4,
        "noise_floor": 0.005,
    },
}


def _synthesize_formant_utterance(
    sr: int,
    duration_sec: float,
    base_f0: float,
    formants: List[Tuple[float, float]],
    syllables: int = 7,
    seed: int = 42,
) -> np.ndarray:
    """Synthesizes a natural-sounding harmonic-formant vocal utterance for reference & cloning."""
    rng = np.random.default_rng(seed)
    n_samples = int(sr * duration_sec)
    t = np.linspace(0.0, duration_sec, n_samples, endpoint=False)

    # Prosodic F0 contour with natural intonation phrase declination + vibrato
    f0_contour = (
        base_f0 * (1.0 + 0.12 * np.sin(2 * np.pi * 1.3 * t + 0.4) - 0.08 * (t / max(duration_sec, 0.1)))
        + 3.5 * np.sin(2 * np.pi * 5.4 * t)
    )
    phase = 2.0 * np.pi * np.cumsum(f0_contour) / sr

    # Rich glottal harmonic source (18 harmonics with spectral tilt)
    glottal = np.zeros(n_samples, dtype=np.float64)
    max_harm = min(22, int((sr * 0.45) // max(base_f0, 60.0)))
    for k in range(1, max_harm + 1):
        amp = 1.0 / (k ** 1.25)
        glottal += amp * np.sin(k * phase + (k * 0.17))

    # Gentle aspiration noise
    aspiration = rng.normal(0.0, 0.025, size=n_samples)
    excitation = glottal + aspiration

    # Apply vocal tract formant resonators (parallel 2nd-order bandpass filters)
    vocal_out = np.zeros(n_samples, dtype=np.float64)
    nyq = 0.5 * sr
    for idx, (f_hz, bw_hz) in enumerate(formants):
        if f_hz >= nyq * 0.92:
            continue
        low = max(40.0, f_hz - bw_hz / 2.0) / nyq
        high = min(nyq * 0.95, f_hz + bw_hz / 2.0) / nyq
        if low >= high:
            continue
        b, a = signal.butter(2, [low, high], btype="band")
        gain = 1.0 / (1.0 + 0.35 * idx)
        vocal_out += gain * signal.lfilter(b, a, excitation)

    # Syllable amplitude envelope (simulating spoken syllables & brief pauses)
    env = np.zeros(n_samples, dtype=np.float64)
    boundaries = np.linspace(0.06 * duration_sec, 0.94 * duration_sec, syllables + 1)
    for i in range(syllables):
        s_t, e_t = boundaries[i], boundaries[i + 1]
        gap = (e_t - s_t) * 0.12
        e_voiced = e_t - gap
        mask = (t >= s_t) & (t <= e_voiced)
        if np.any(mask):
            local = (t[mask] - s_t) / max(1e-4, e_voiced - s_t)
            # Smooth attack-sustain-release syllable window
            env[mask] = np.sin(np.pi * np.clip(local, 0, 1)) ** 0.45 * (0.82 + 0.18 * rng.random())

    y = (vocal_out * env).astype(np.float32)
    peak = float(np.max(np.abs(y)))
    if peak > 1e-6:
        y = 0.82 * (y / peak)
    return y


def ensure_sample_voice_dataset() -> Path:
    """Creates real playable reference voice samples in `kaggle_workspace/input/sample-voice-dataset`."""
    rt = get_kaggle_runtime()
    ds_dir = rt.input_dir / "sample-voice-dataset"
    ds_dir.mkdir(parents=True, exist_ok=True)

    presets = [
        {
            "filename": "speaker_female_clear.wav",
            "speaker_id": "spk_female_01",
            "label": "清晰女声参考音 (Female Clear 24kHz)",
            "sr": 24000,
            "duration": 2.6,
            "f0": 218.0,
            "formants": [(720.0, 90.0), (2080.0, 130.0), (2950.0, 170.0), (3850.0, 220.0)],
            "transcript": "欢迎使用克隆语音实验与Kaggle模拟器系统。",
            "seed": 101,
        },
        {
            "filename": "speaker_male_warm.wav",
            "speaker_id": "spk_male_02",
            "label": "沉稳男声参考音 (Male Warm 24kHz)",
            "sr": 24000,
            "duration": 2.8,
            "f0": 122.0,
            "formants": [(520.0, 80.0), (1480.0, 110.0), (2480.0, 150.0), (3350.0, 200.0)],
            "transcript": "真实保存完整代码到项目仓库并同步更新。",
            "seed": 202,
        },
        {
            "filename": "speaker_bilingual_bright.wav",
            "speaker_id": "spk_biling_03",
            "label": "中英双语明亮音色 (Bilingual Bright 24kHz)",
            "sr": 24000,
            "duration": 2.5,
            "f0": 176.0,
            "formants": [(630.0, 85.0), (1820.0, 120.0), (2720.0, 160.0), (3620.0, 210.0)],
            "transcript": "Zero-shot voice cloning on Kaggle GPU simulator.",
            "seed": 303,
        },
    ]

    meta_csv = ds_dir / "metadata.csv"
    rows = []
    for p in presets:
        wav_path = ds_dir / p["filename"]
        if not wav_path.exists():
            wav = _synthesize_formant_utterance(
                sr=p["sr"],
                duration_sec=p["duration"],
                base_f0=p["f0"],
                formants=p["formants"],
                syllables=8,
                seed=p["seed"],
            )
            sf.write(str(wav_path), wav, p["sr"])
        rows.append(
            {
                "speaker_id": p["speaker_id"],
                "audio_file": p["filename"],
                "sample_rate": p["sr"],
                "label": p["label"],
                "transcript": p["transcript"],
            }
        )

    if not meta_csv.exists():
        with open(meta_csv, "w", newline="", encoding="utf-8") as fp:
            writer = csv.DictWriter(fp, fieldnames=["speaker_id", "audio_file", "sample_rate", "label", "transcript"])
            writer.writeheader()
            writer.writerows(rows)

    return ds_dir


def compute_speaker_embedding(y: np.ndarray, sr: int) -> np.ndarray:
    """
    Computes a deterministic 256-dim L2-normalized acoustic speaker embedding
    combining MFCCs, ΔMFCCs, spectral contrast, spectral centroid/rolloff, and F0 statistics.
    """
    if len(y) < 512:
        y = np.pad(y, (0, 512 - len(y)))
    y = y.astype(np.float32)

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=40)
    delta = librosa.feature.delta(mfcc)
    contrast = librosa.feature.spectral_contrast(y=y, sr=sr, n_bands=6)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)
    f0 = librosa.yin(y, fmin=65.0, fmax=450.0, sr=sr)
    voiced = f0[(f0 > 68.0) & (f0 < 440.0)]
    if len(voiced) == 0:
        voiced = np.array([150.0], dtype=np.float32)

    stats = np.concatenate(
        [
            np.mean(mfcc, axis=1),
            np.std(mfcc, axis=1),
            np.mean(delta, axis=1),
            np.std(delta, axis=1),
            np.mean(contrast, axis=1),
            np.std(contrast, axis=1),
            [
                float(np.mean(centroid)) / sr,
                float(np.std(centroid)) / sr,
                float(np.mean(rolloff)) / sr,
                float(np.mean(voiced)) / 300.0,
                float(np.std(voiced)) / 100.0,
                float(np.percentile(voiced, 25)) / 300.0,
                float(np.percentile(voiced, 75)) / 300.0,
            ],
        ]
    ).astype(np.float32)

    # Pad or project deterministically to 256-d speaker embedding
    if len(stats) < 256:
        rng = np.random.default_rng(12345)
        proj = rng.normal(0.0, 1.0 / math.sqrt(len(stats)), size=(len(stats), 256 - len(stats))).astype(np.float32)
        extra = stats @ proj
        emb = np.concatenate([stats, extra])
    else:
        emb = stats[:256]

    norm = float(np.linalg.norm(emb))
    return emb / max(norm, 1e-8)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def compute_mcd_db(y_ref: np.ndarray, y_syn: np.ndarray, sr: int) -> float:
    """Computes Mel-Cepstral Distortion (MCD in dB) using dynamic time-aligned MFCCs (c1..c13)."""
    mfcc_ref = librosa.feature.mfcc(y=y_ref.astype(np.float32), sr=sr, n_mfcc=14)[1:14]
    mfcc_syn = librosa.feature.mfcc(y=y_syn.astype(np.float32), sr=sr, n_mfcc=14)[1:14]
    t_len = min(mfcc_ref.shape[1], mfcc_syn.shape[1], 120)
    idx_r = np.linspace(0, mfcc_ref.shape[1] - 1, t_len).astype(int)
    idx_s = np.linspace(0, mfcc_syn.shape[1] - 1, t_len).astype(int)
    diff = mfcc_ref[:, idx_r] - mfcc_syn[:, idx_s]
    # Scale to standard speech MCD range (typically 3.5 - 8.5 dB)
    dist = np.mean(np.sqrt(np.sum((diff / 18.0) ** 2, axis=0)))
    mcd = (10.0 / math.log(10.0)) * math.sqrt(2.0) * float(dist)
    return round(float(mcd), 3)


def _render_acoustic_plot_b64(
    y_ref: np.ndarray,
    sr: int,
    y_cloned: Optional[np.ndarray] = None,
    title_prefix: str = "Voice Acoustic Analysis",
) -> str:
    rows = 2 if y_cloned is None else 3
    fig, axes = plt.subplots(rows, 1, figsize=(8.6, 2.3 * rows), constrained_layout=True)
    fig.patch.set_facecolor("#0f172a")

    def style_ax(ax: Any, title: str) -> None:
        ax.set_facecolor("#1e293b")
        ax.set_title(title, color="#e2e8f0", fontsize=10, pad=5)
        ax.tick_params(colors="#94a3b8", labelsize=8)
        for spine in ax.spines.values():
            spine.set_color("#334155")

    # 1. Reference Waveform
    t_ref = np.linspace(0, len(y_ref) / sr, len(y_ref))
    axes[0].plot(t_ref, y_ref, color="#38bdf8", linewidth=0.75)
    style_ax(axes[0], f"{title_prefix} — Reference Waveform ({sr} Hz, {len(y_ref)/sr:.2f}s)")
    axes[0].set_ylabel("Amp", color="#94a3b8", fontsize=8)

    # 2. Reference Log-Mel Spectrogram
    mel_ref = librosa.power_to_db(librosa.feature.melspectrogram(y=y_ref, sr=sr, n_mels=80), ref=np.max)
    axes[1].imshow(mel_ref, aspect="auto", origin="lower", cmap="magma")
    style_ax(axes[1], "Reference 80-Band Log-Mel Spectrogram")
    axes[1].set_ylabel("Mel Bin", color="#94a3b8", fontsize=8)

    # 3. Cloned Log-Mel Spectrogram (if present)
    if y_cloned is not None:
        mel_cl = librosa.power_to_db(librosa.feature.melspectrogram(y=y_cloned, sr=sr, n_mels=80), ref=np.max)
        axes[2].imshow(mel_cl, aspect="auto", origin="lower", cmap="viridis")
        style_ax(axes[2], f"Cloned Output Log-Mel Spectrogram ({len(y_cloned)/sr:.2f}s)")
        axes[2].set_ylabel("Mel Bin", color="#94a3b8", fontsize=8)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def analyze_voice_file(audio_path: Path) -> Dict[str, Any]:
    """Extracts comprehensive acoustic & speaker timbre metrics from a reference audio file."""
    resolved = Path(get_kaggle_runtime().translate_kaggle_path(str(audio_path)))
    y, sr = sf.read(str(resolved), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = np.mean(y, axis=1)

    intervals = librosa.effects.split(y, top_db=28)
    voiced_samples = sum(int(e - s) for s, e in intervals)
    vad_ratio = round(voiced_samples / max(1, len(y)), 3)

    rms = float(np.sqrt(np.mean(np.square(y)) + 1e-12))
    rms_dbfs = round(20.0 * math.log10(max(rms, 1e-6)), 2)

    f0 = librosa.yin(y, fmin=65.0, fmax=450.0, sr=sr)
    valid_f0 = f0[(f0 > 68.0) & (f0 < 440.0)]
    if len(valid_f0) == 0:
        valid_f0 = np.array([150.0], dtype=np.float32)

    emb = compute_speaker_embedding(y, sr)
    plot_b64 = _render_acoustic_plot_b64(y, sr, title_prefix=resolved.name)

    return {
        "file_name": resolved.name,
        "sample_rate": int(sr),
        "duration_sec": round(len(y) / sr, 3),
        "num_samples": int(len(y)),
        "rms_dbfs": rms_dbfs,
        "vad_speech_ratio": vad_ratio,
        "f0_mean_hz": round(float(np.mean(valid_f0)), 2),
        "f0_std_hz": round(float(np.std(valid_f0)), 2),
        "f0_min_hz": round(float(np.min(valid_f0)), 2),
        "f0_max_hz": round(float(np.max(valid_f0)), 2),
        "embedding_dim": int(len(emb)),
        "embedding_preview": [round(float(v), 4) for v in emb[:12]],
        "plot_b64": plot_b64,
    }


def _estimate_formants_from_reference(y: np.ndarray, sr: int) -> List[Tuple[float, float]]:
    """Extracts dominant spectral envelope peaks from reference audio to transfer vocal timbre."""
    spec = np.mean(np.abs(librosa.stft(y, n_fft=1024)), axis=1)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    # Smooth spectral envelope
    kernel = np.ones(7) / 7.0
    smoothed = np.convolve(spec, kernel, mode="same")
    peaks, _ = signal.find_peaks(smoothed, distance=8)
    valid = [float(freqs[p]) for p in peaks if 300.0 <= freqs[p] <= 4200.0]
    if len(valid) < 3:
        return [(600.0, 90.0), (1750.0, 120.0), (2700.0, 160.0), (3550.0, 210.0)]
    chosen = valid[:4]
    bws = [85.0, 120.0, 160.0, 210.0]
    return [(chosen[i], bws[i]) for i in range(len(chosen))]


def run_voice_cloning_simulation(
    ref_audio_path: Path,
    target_text: str,
    architecture_id: str = "qwen_cosyvoice_codec",
    speed: float = 1.0,
    pitch_shift_semitones: float = 0.0,
    temperature: float = 0.7,
    nfe_steps: int = 24,
) -> Dict[str, Any]:
    """
    Runs end-to-end Voice Cloning DSP + Pipeline Simulation:
    - Extracts speaker timbre (F0 + Formant envelope + 256-d speaker embedding) from `ref_audio_path`
    - Synthesizes cloned speech conditioned on `target_text` length, prosody, speed, and pitch shift
    - Computes SECS (Speaker Cosine Similarity), MCD (dB), RTF, and Kaggle GPU VRAM telemetry
    """
    ensure_sample_voice_dataset()
    rt = get_kaggle_runtime()
    arch = ARCHITECTURES.get(architecture_id, ARCHITECTURES["qwen_cosyvoice_codec"])
    target_sr = int(arch["sample_rate"])

    t0 = time.perf_counter()
    resolved_ref = Path(rt.translate_kaggle_path(str(ref_audio_path)))
    y_ref, ref_sr = sf.read(str(resolved_ref), dtype="float32", always_2d=False)
    if y_ref.ndim > 1:
        y_ref = np.mean(y_ref, axis=1)
    if ref_sr != target_sr:
        y_ref = librosa.resample(y_ref, orig_sr=ref_sr, target_sr=target_sr)

    # Extract reference F0 & vocal tract formants
    f0 = librosa.yin(y_ref, fmin=65.0, fmax=450.0, sr=target_sr)
    valid_f0 = f0[(f0 > 68.0) & (f0 < 440.0)]
    ref_f0_mean = float(np.mean(valid_f0)) if len(valid_f0) > 0 else 165.0
    shifted_f0 = ref_f0_mean * (2.0 ** (pitch_shift_semitones / 12.0))
    formants = _estimate_formants_from_reference(y_ref, target_sr)

    # Derive syllable count & duration from target_text
    clean_text = target_text.strip() or "你好，这是克隆语音系统的合成测试音频。"
    char_units = max(3, min(40, len([ch for ch in clean_text if not ch.isspace()])))
    syllables = max(3, min(28, int(round(char_units * 0.75))))
    duration_sec = float(np.clip((syllables * 0.24) / max(0.5, min(2.0, speed)), 1.2, 8.5))

    text_seed = int(hashlib.sha256(f"{clean_text}:{architecture_id}:{temperature}".encode("utf-8")).hexdigest()[:8], 16)
    y_cloned = _synthesize_formant_utterance(
        sr=target_sr,
        duration_sec=duration_sec,
        base_f0=shifted_f0,
        formants=formants,
        syllables=syllables,
        seed=text_seed,
    )

    # Apply subtle spectral envelope matching toward reference speaker
    ref_spec = np.mean(np.abs(librosa.stft(y_ref, n_fft=512)), axis=1, keepdims=True) + 1e-5
    cl_stft = librosa.stft(y_cloned, n_fft=512)
    cl_spec = np.mean(np.abs(cl_stft), axis=1, keepdims=True) + 1e-5
    gain_curve = np.clip((ref_spec / cl_spec) ** 0.55, 0.35, 2.8)
    y_cloned = librosa.istft(cl_stft * gain_curve, length=len(y_cloned)).astype(np.float32)

    # Normalize output peak safely
    peak = float(np.max(np.abs(y_cloned)))
    if peak > 1e-6:
        y_cloned = (0.85 * y_cloned / peak).astype(np.float32)

    out_dir = rt.working_dir / "cloned_outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_name = f"cloned_{architecture_id}_{int(time.time() * 1000)}.wav"
    out_path = out_dir / out_name
    sf.write(str(out_path), y_cloned, target_sr)

    elapsed_sec = max(1e-4, time.perf_counter() - t0)

    # Objective Voice Cloning Evaluation Metrics
    emb_ref = compute_speaker_embedding(y_ref, target_sr)
    emb_cl = compute_speaker_embedding(y_cloned, target_sr)
    secs = round(max(0.0, min(0.999, cosine_similarity(emb_ref, emb_cl))), 4)
    mcd_db = compute_mcd_db(y_ref, y_cloned, target_sr)
    rtf = round(elapsed_sec / duration_sec, 4)

    cl_f0 = librosa.yin(y_cloned, fmin=65.0, fmax=450.0, sr=target_sr)
    cl_valid = cl_f0[(cl_f0 > 68.0) & (cl_f0 < 440.0)]
    cl_f0_mean = float(np.mean(cl_valid)) if len(cl_valid) > 0 else shifted_f0

    accel = rt.get_accelerator_spec()
    mel_frames = int((duration_sec * target_sr) // 256)
    est_vram_gb = round(arch["base_vram_gb"] + (mel_frames / 1000.0) * 0.45 + (nfe_steps / 32.0) * 0.25, 2)
    vram_limit_gb = round(accel.vram_mib_per_gpu / 1024.0, 2) if accel.device_count > 0 else 0.0

    plot_b64 = _render_acoustic_plot_b64(
        y_ref, target_sr, y_cloned=y_cloned, title_prefix=arch.get("plot_title", arch["id"])
    )
    rel_out = out_path.relative_to(PROJECT_ROOT).as_posix()
    rel_ref = resolved_ref.relative_to(PROJECT_ROOT).as_posix() if resolved_ref.is_relative_to(PROJECT_ROOT) else str(resolved_ref)

    return {
        "architecture": arch,
        "target_text": clean_text,
        "reference_audio_url": f"/api/media?path={rel_ref}",
        "cloned_audio_url": f"/api/media?path={rel_out}",
        "cloned_project_path": rel_out,
        "cloned_kaggle_path": f"/kaggle/working/cloned_outputs/{out_name}",
        "metrics": {
            "speaker_cosine_similarity_secs": secs,
            "mcd_db": mcd_db,
            "ref_f0_hz": round(ref_f0_mean, 2),
            "cloned_f0_hz": round(cl_f0_mean, 2),
            "duration_sec": round(duration_sec, 2),
            "sample_rate": target_sr,
            "mel_frames": mel_frames,
            "rtf": rtf,
            "synthesis_latency_ms": round(elapsed_sec * 1000.0, 1),
            "estimated_kaggle_vram_gb": est_vram_gb,
            "kaggle_gpu_limit_gb": vram_limit_gb,
            "kaggle_accelerator": accel.label,
        },
        "tensor_trace": [
            {"stage": "ref_waveform", "shape": [1, int(len(y_ref))], "dtype": "float32"},
            {"stage": "speaker_embedding", "shape": [1, 256], "dtype": "float32"},
            {"stage": "semantic_tokens", "shape": [1, int(duration_sec * 25)], "dtype": "int64"},
            {"stage": "acoustic_mel", "shape": [1, arch["n_mels"], mel_frames], "dtype": "float16"},
            {"stage": "cloned_waveform", "shape": [1, int(len(y_cloned))], "dtype": "float32"},
        ],
        "plot_b64": plot_b64,
    }
