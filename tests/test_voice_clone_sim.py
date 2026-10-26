"""Tests for Voice Cloning DSP Synthesis, Acoustic Analyzer, and Kaggle GPU VRAM Simulator."""

from __future__ import annotations

from simulators.voice_clone_sim import (
    analyze_voice_file,
    ensure_sample_voice_dataset,
    run_voice_cloning_simulation,
    simulate_kaggle_training_experiment,
)


def test_sample_dataset_and_acoustic_analysis() -> None:
    ds_dir = ensure_sample_voice_dataset()
    ref_wav = ds_dir / "speaker_female_clear.wav"
    assert ref_wav.exists()

    analysis = analyze_voice_file(ref_wav)
    assert analysis["sample_rate"] == 24000
    assert analysis["duration_sec"] > 1.0
    assert analysis["embedding_dim"] == 256
    assert 120.0 <= analysis["f0_mean_hz"] <= 350.0
    assert len(analysis["plot_b64"]) > 100


def test_end_to_end_voice_cloning_simulation() -> None:
    ds_dir = ensure_sample_voice_dataset()
    ref_wav = ds_dir / "speaker_male_warm.wav"

    res = run_voice_cloning_simulation(
        ref_audio_path=ref_wav,
        target_text="测试克隆语音合成系统的音色相似度与频谱输出。",
        architecture_id="f5_flow_matching",
        speed=1.0,
        pitch_shift_semitones=0.0,
    )
    metrics = res["metrics"]
    assert 0.5 <= metrics["speaker_cosine_similarity_secs"] <= 1.0
    assert metrics["mcd_db"] > 0.0
    assert len(res["tensor_trace"]) == 5
    assert len(res["plot_b64"]) > 100


def test_kaggle_vram_and_training_simulator() -> None:
    safe_run = simulate_kaggle_training_experiment(
        architecture_id="qwen_cosyvoice_codec",
        accelerator_id="T4x2",
        finetune_mode="lora",
        precision="fp16",
        batch_size=4,
        epochs=6,
    )
    assert safe_run["vram_breakdown_gb"]["oom_risk"] is False
    assert len(safe_run["history"]) == 6

    oom_run = simulate_kaggle_training_experiment(
        architecture_id="qwen_cosyvoice_codec",
        accelerator_id="P100",
        finetune_mode="full",
        precision="fp32",
        batch_size=32,
        max_audio_sec=25.0,
        epochs=4,
    )
    assert oom_run["vram_breakdown_gb"]["oom_risk"] is True
