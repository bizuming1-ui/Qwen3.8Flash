"""Voice Cloning Acoustic DSP, Architecture Pipeline, and Kaggle GPU Benchmark Simulators."""

from .dsp_engine import (
    ARCHITECTURES,
    analyze_voice_file,
    compute_mcd_db,
    compute_speaker_embedding,
    cosine_similarity,
    ensure_sample_voice_dataset,
    run_voice_cloning_simulation,
)
from .benchmark import simulate_kaggle_training_experiment

__all__ = [
    "ARCHITECTURES",
    "ensure_sample_voice_dataset",
    "analyze_voice_file",
    "compute_speaker_embedding",
    "cosine_similarity",
    "compute_mcd_db",
    "run_voice_cloning_simulation",
    "simulate_kaggle_training_experiment",
]
