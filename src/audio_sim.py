"""语音克隆实验模拟器(纯标准库, 无需 torch/numpy)。

定位说明(重要): 本模块是「管线模拟器」, 不是 Qwen3-TTS 本身。
它用确定性 DSP 伪合成(基频+谐波+共振峰包络, 由参考音频的音高/能量驱动)
让你在没有 GPU / 模型权重时, 也能完整跑通:
  参考音频 → 参数面板 → 合成 → 波形/频谱 → 指标 → 实验落盘
这条实验链路。等你在真实 Kaggle(GPU)里跑通 Qwen3-TTS 推理代码后,
把 `synthesize_with_model()` 换成你的模型调用即可(接口已预留)。

提供的分析(波形统计、ZCR 估音高、STFT 频谱图 PNG)均为真实 DSP 计算,
可以用于检查你自己模型输出的 wav 是否正常。
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
import wave
import zlib
from pathlib import Path

SAMPLE_RATE = 22050


# ---------------- WAV 基础读写 ----------------

def write_wav(path: str | Path, samples: list[float], sr: int = SAMPLE_RATE) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)
    return path


def read_wav(path: str | Path) -> tuple[list[float], int]:
    """读取 16-bit PCM wav, 多声道自动混成单声道。"""
    with wave.open(str(path), "rb") as w:
        sr, nch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = w.readframes(n)
        if w.getsampwidth() != 2:
            raise ValueError("仅支持 16-bit PCM wav")
    vals = struct.unpack(f"<{len(raw) // 2}h", raw)
    if nch > 1:
        vals = tuple(sum(vals[i:i + nch]) / nch for i in range(0, len(vals), nch))  # type: ignore[assignment]
    return [v / 32768.0 for v in vals], sr


# ---------------- 真实 DSP 分析 ----------------

def analyze(samples: list[float], sr: int) -> dict:
    if not samples:
        return {"duration_sec": 0, "rms": 0, "peak": 0, "est_pitch_hz": 0, "sample_rate": sr}
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    # 自相关估基频(取能量最高的一帧, 在 60-400Hz 滞后范围内找峰)
    pitch = 0.0
    frame = 2048
    if len(samples) >= frame:
        best_i, best_e = 0, -1.0
        step = max(1, (len(samples) - frame) // 40)  # 最多抽查 40 帧, 保持纯 Python 也够快
        for i in range(0, len(samples) - frame, step):
            e = sum(s * s for s in samples[i:i + frame:16])
            if e > best_e:
                best_e, best_i = e, i
        seg = samples[best_i:best_i + frame]
        mean = sum(seg) / len(seg)
        seg = [s - mean for s in seg]
        lo, hi = max(2, sr // 400), min(frame - 1, sr // 60)
        ac = [sum(seg[i] * seg[i + lag] for i in range(0, frame - lag, 2)) for lag in range(lo, hi)]
        if ac and max(ac) > 0:
            lag = lo + ac.index(max(ac))
            # 子样本抛物线插值微调
            k = lag - lo
            if 0 < k < len(ac) - 1:
                denom = ac[k - 1] - 2 * ac[k] + ac[k + 1]
                shift = 0.5 * (ac[k - 1] - ac[k + 1]) / denom if denom else 0.0
                lag = lag + shift
            pitch = sr / lag
    return {
        "duration_sec": round(len(samples) / sr, 3),
        "rms": round(rms, 4),
        "peak": round(peak, 4),
        "est_pitch_hz": round(pitch, 1),
        "sample_rate": sr,
        "num_samples": len(samples),
    }


def _fft(re: list[float], im: list[float]) -> tuple[list[float], list[float]]:
    n = len(re)
    if n == 1:
        return re, im
    er, ei = _fft(re[0::2], im[0::2])
    orr, oi = _fft(re[1::2], im[1::2])
    out_r, out_i = [0.0] * n, [0.0] * n
    for k in range(n // 2):
        ang = -2 * math.pi * k / n
        c, s = math.cos(ang), math.sin(ang)
        tr, ti = c * orr[k] - s * oi[k], s * orr[k] + c * oi[k]
        out_r[k], out_i[k] = er[k] + tr, ei[k] + ti
        out_r[k + n // 2], out_i[k + n // 2] = er[k] - tr, ei[k] - ti
    return out_r, out_i


# viridis 近似色板(锚点色线性插值)
_VIRIDIS = [(68, 1, 84), (59, 82, 139), (33, 145, 140), (94, 201, 98), (253, 231, 37)]


def _color(v: float) -> tuple[int, int, int]:
    v = max(0.0, min(1.0, v))
    x = v * (len(_VIRIDIS) - 1)
    i, f = int(x), x - int(x)
    if i >= len(_VIRIDIS) - 1:
        return _VIRIDIS[-1]
    a, b = _VIRIDIS[i], _VIRIDIS[i + 1]
    return tuple(int(a[c] + (b[c] - a[c]) * f) for c in range(3))  # type: ignore[return-value]


def _png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", c)

    raw = b"".join(b"\x00" + r for r in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def spectrogram_png(samples: list[float], sr: int, width: int = 720, height: int = 240) -> bytes:
    """真实 STFT(512 点 FFT, 汉宁窗, 对数频带)→ viridis 频谱图 PNG。"""
    n_fft, hop = 512, 256
    if len(samples) < n_fft:
        samples = samples + [0.0] * (n_fft - len(samples))
    frames = max(1, (len(samples) - n_fft) // hop + 1)
    # 对数频带边界(40Hz ~ sr/2)
    bands = height
    edges = [int(round((n_fft // 2) * (40 / (sr / 2)) ** (1 - i / bands))) for i in range(bands + 1)]
    edges = [min(max(e, 1), n_fft // 2) for e in edges]
    cols: list[list[float]] = []
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / (n_fft - 1)) for i in range(n_fft)]
    peak_db = -1e9
    for f in range(frames):
        seg = samples[f * hop:f * hop + n_fft]
        re = [seg[i] * win[i] for i in range(n_fft)]
        im = [0.0] * n_fft
        fr, fi = _fft(re, im)
        mags = [math.hypot(fr[k], fi[k]) for k in range(n_fft // 2 + 1)]
        col = []
        for b in range(bands):
            lo, hi = edges[b], max(edges[b] + 1, edges[b + 1])
            m = max(mags[lo:hi]) if lo < len(mags) else 0.0
            db = 20 * math.log10(m + 1e-9)
            peak_db = max(peak_db, db)
            col.append(db)
        cols.append(col)
    # 重采样到目标宽度
    rows: list[bytes] = []
    for y in range(height):
        band = bands - 1 - y
        row = bytearray()
        for x in range(width):
            ci = min(len(cols) - 1, int(x / width * len(cols)))
            v = (cols[ci][band] - (peak_db - 80)) / 80.0
            row += bytes(_color(v))
        rows.append(bytes(row))
    return _png(width, height, rows)


# ---------------- 模拟合成 ----------------

def _seed_float(*parts: str, lo: float = 0.0, hi_one: float = 1.0) -> float:
    h = hashlib.sha256("|".join(parts).encode()).digest()
    v = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
    return lo + v * hi_one


def synthesize(
    text: str,
    out_path: str | Path,
    *,
    ref_samples: list[float] | None = None,
    ref_sr: int = SAMPLE_RATE,
    language: str = "zh",
    speed: float = 1.0,
    pitch_semitones: float = 0.0,
    temperature: float = 0.8,
    similarity: float = 0.85,
) -> dict:
    """确定性伪语音合成: 每个音节 = 基频谐波串 × 共振峰包络 × 时域包络。

    - 基频: 优先取参考音频估计音高(体现“克隆”音色锚点), 再叠加音调滑杆
    - 韵律: 标点产生停顿与句调下倾/上扬; 中文逐字成音节, 英文按词
    - temperature 只影响微观抖动(模拟采样随机性), 且带文本种子 => 可复现
    """
    text = (text or "").strip() or "你好，这是语音克隆模拟器的测试音频。"
    base_f0 = 170.0
    ref_stats = None
    if ref_samples:
        ref_stats = analyze(ref_samples, ref_sr)
        if 60 <= ref_stats["est_pitch_hz"] <= 400:
            base_f0 = base_f0 * (1 - similarity) + ref_stats["est_pitch_hz"] * similarity
    base_f0 *= 2 ** (pitch_semitones / 12.0)

    tokens: list[tuple[str, float]] = []  # (符号, 相对时长)
    if language.startswith("en"):
        for w in text.replace(",", " ,").replace(".", " .").split():
            tokens.append((w, 0.32 if w not in ",." else 0.25))
    else:
        for ch in text:
            if ch in "，。！？；、,.!?;":
                tokens.append((ch, 0.30))
            elif ch.isspace():
                tokens.append((" ", 0.12))
            else:
                tokens.append((ch, 0.24))

    samples: list[float] = []
    phase = 0.0
    sent_len = max(1, len([t for t, _ in tokens if t.strip()]))
    voiced_i = 0
    for tok, dur in tokens:
        n = int(SAMPLE_RATE * dur / max(0.3, speed))
        if tok in "，。！？；、,.!?; ":
            samples.extend([0.0] * n)
            continue
        voiced_i += 1
        # 音节级基频: 声调由字符种子给出(模拟字调), 句尾下倾
        tone = _seed_float(tok, "tone", lo=-3.0, hi_one=6.0)  # 半音
        decl = -2.5 * (voiced_i / sent_len)
        jit = _seed_float(tok, str(voiced_i), "jit", lo=-1.0, hi_one=2.0) * temperature * 0.4
        f0 = base_f0 * 2 ** ((tone + decl + jit) / 12.0)
        # 共振峰(由字符决定, 模拟不同元音): 两组带宽谐振做幅度加权近似
        f1 = 300 + _seed_float(tok, "f1") * 600
        f2 = 900 + _seed_float(tok, "f2") * 1500
        for i in range(n):
            t = i / SAMPLE_RATE
            env = min(1.0, i / (0.03 * SAMPLE_RATE)) * min(1.0, (n - i) / (0.05 * SAMPLE_RATE))
            phase += 2 * math.pi * f0 / SAMPLE_RATE
            s = 0.0
            for h_ in range(1, 13):
                fh = f0 * h_
                if fh > SAMPLE_RATE / 2:
                    break
                w1 = math.exp(-((fh - f1) ** 2) / (2 * 160.0 ** 2))
                w2 = math.exp(-((fh - f2) ** 2) / (2 * 260.0 ** 2))
                s += (0.25 + 0.75 * max(w1, 0.6 * w2)) / h_ * math.sin(phase * h_)
            vib = 1 + 0.02 * math.sin(2 * math.pi * 5.2 * (len(samples) + i) / SAMPLE_RATE)
            samples.append(0.55 * env * vib * s)
    samples.extend([0.0] * int(0.15 * SAMPLE_RATE))
    # 峰值归一化到 -1 dBFS
    peak = max((abs(s) for s in samples), default=1.0) or 1.0
    gain = 0.89 / peak
    samples = [s * gain for s in samples]
    write_wav(out_path, samples)
    stats = analyze(samples, SAMPLE_RATE)
    return {"stats": stats, "ref_stats": ref_stats, "base_f0_hz": round(base_f0, 1)}


def simulator_metrics(text: str, params: dict, has_ref: bool) -> dict:
    """模拟器指标(确定性伪指标, 仅用于实验对比记录; 真实指标需在 Kaggle 用
    ECAPA/Whisper/MOS 模型计算, 见 notebooks 模板中的说明)。"""
    sim = params.get("similarity", 0.85)
    temp = params.get("temperature", 0.8)
    base = 0.72 + 0.22 * sim - 0.05 * abs(temp - 0.8) + (0.03 if has_ref else -0.08)
    jitter = _seed_float(text, json.dumps(params, sort_keys=True), lo=-0.015, hi_one=0.03)
    spk_sim = round(max(0.0, min(0.99, base + jitter)), 3)
    mos = round(max(1.0, min(4.9, 3.4 + (spk_sim - 0.7) * 2.2 + jitter)), 2)
    wer = round(max(0.0, 0.16 - (spk_sim - 0.7) * 0.25 + abs(temp - 0.8) * 0.05), 3)
    return {"speaker_similarity(SIM)": spk_sim, "MOS(sim)": mos, "WER(sim)": wer,
            "_note": "模拟器伪指标, 用于跑通实验记录流程; 不代表真实模型质量。"}


def synthesize_with_model(*_args, **_kwargs):  # pragma: no cover - 集成占位
    raise NotImplementedError(
        "在此替换为你的 Qwen3-TTS / 语音克隆模型推理调用(需 GPU 环境, 如 Kaggle)。\n"
        "接口约定: 输入 text/ref_audio/params, 输出 wav 文件路径。"
        "示例接法见 notebooks/01_qwen3_voice_clone_template.py 的 [真实模型区] 注释段。"
    )
