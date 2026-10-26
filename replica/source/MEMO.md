# Strict reference-context engineering candidate — NOT quality-released
Actual uploaded base SHA256: 4f0c98327233f512753146828e664cf89b60f8b34674a587d7d819a6854b3228
Default speaker-only; ICL rejected. Actual prompt and prepare output checked before generation.
Four codec/DSP policies, training, monitoring, private entry and browser assets retained.
Speaker-only can change prosody. No real model/ASR/T4/listening validation yet.
No semantic ASR gate implemented: do NOT claim no extra words or no hiss.
Notebook paste only checks source; existing services must not be replaced by this unvalidated candidate.

--- Original scope memo below ---
# 当前完整源码候选：从可核验S5接线，非正式18发布
默认ICL/6dB上限仍为继承值；不预填用户文本或声音，不拼参考PCM。
分析/校准/S4 worker/S5播放器实际接线；DSP使用numpy-causal-v1，Rust不启用。
真实训练、双T4模型、音质、DeepSeek、实体首声/RTF均未签；建档不等于训练。
S6–S8-C文件当前缺失，未冒称恢复；详见README.zh-CN.md。

Diagnostic follow-up: explicit mode/content source, source ID, segment association and conservative ASR flags. Source IDs are self-reported, not hardware/quality attestation.

2026-10-25 audit candidate: ties profile-ready and synthesis receipts with the existing voice_binding fingerprint; records manual-text use and anchor index; labels the speech-envelope spread heuristic as a proxy rather than true SNR; marks extra breath playback unavailable. No denoise threshold, gain, speaker-conditioning mode, reference PCM policy, or model weights changed. This is not model/audio-quality validation.

Hybrid follow-up (2026-10-25): adds only the optional sentence-agc-headroom policy; it retains B's sentence AGC and uses a separate soft limiter with threshold 0.84, knee 0.02, and asymptotic ceiling 0.86 (about -1.31 dBFS), informed by A's observed sample peak. This changes peak shaping only in the new policy; existing policies keep their prior limiter defaults. Experimental; not runtime/model/audio-quality validated.
