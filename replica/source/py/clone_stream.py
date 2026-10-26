"""Faster0.5.4 generation adapter: strict speaker-only conditioning, GENERATED-ONLY codec decode.

No reference codes/PCM enter the codec. Fixed Qwen 12.5Hz contract: 16 codebooks,
24kHz, 1920 samples/frame. Fail closed if the actual tokenizer differs.
CPU fixture experiments are not trained-model quality/T4 performance evidence.
"""
from __future__ import annotations
import os
import time
import numpy as np
from reference_guard import clone_mode, generation_prompt, prepared_without_reference


def conditioning(prof: dict) -> tuple[str, bool]:
    clone_mode()
    return '', True


def codec_lookahead_frames():
    try:
        value = int(os.environ.get('QTTS_CODEC_LOOKAHEAD_FRAMES', '0'))
    except ValueError as error:
        raise ValueError('QTTS_CODEC_LOOKAHEAD_FRAMES must be 0..2') from error
    if not 0 <= value <= 2:
        raise ValueError('QTTS_CODEC_LOOKAHEAD_FRAMES must be 0..2')
    return value


class GeneratedCodecWindow:
    """25-frame left context; optional right lookahead. No repeated committed PCM."""
    def __init__(self, tokenizer, context=25, lookahead=0):
        if not 1 <= context <= 64 or not 0 <= lookahead <= 8:
            raise ValueError('invalid codec window')
        self.tokenizer, self.context, self.lookahead = tokenizer, context, lookahead
        self.codes = None
        self.start = self.total = self.committed = self.peak_frames = self.decoder_calls = 0
        self.pending = np.zeros(0, np.float32)
        self.closed = False

    def push(self, chunk):
        import torch
        if self.closed:
            raise RuntimeError('codec window already finished')
        if chunk.ndim != 2 or chunk.shape[1] != 16 or not 1 <= chunk.shape[0] <= 16:
            raise RuntimeError('expected 1..16 GENERATED frames with 16 codebooks')
        window = chunk if self.codes is None else torch.cat((self.codes, chunk), dim=0)
        self.total += int(chunk.shape[0])
        self.peak_frames = max(self.peak_frames, int(window.shape[0]))
        if window.shape[0] > self.context + self.lookahead + 16:
            raise RuntimeError('codec window exceeded bounded context')
        self.decoder_calls += 1
        audio_list, sr = self.tokenizer.decode({'audio_codes': window.unsqueeze(0)})
        audio = audio_list[0]
        if hasattr(audio, 'detach'):
            audio = audio.detach().float().cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if int(sr) != 24000 or len(audio) != window.shape[0] * 1920 or not np.isfinite(audio).all():
            raise RuntimeError('codec must return finite 24kHz PCM, exactly 1920 samples per generated frame')
        end = max(self.committed, self.total - self.lookahead)
        lo = (self.committed - self.start) * 1920
        hi = (end - self.start) * 1920
        out = audio[lo:hi].copy()
        self.pending = audio[hi:].copy()
        self.committed = end
        retain_from = max(0, end - self.context)
        self.codes = window[retain_from - self.start:].clone()
        self.start = retain_from
        return out

    def finish(self, cancelled=False):
        if self.closed:
            return np.zeros(0, np.float32)
        self.closed = True
        out = np.zeros(0, np.float32) if cancelled else self.pending
        self.pending = np.zeros(0, np.float32)
        self.codes = None
        return out


class GeneratedSentenceCodec:
    """Bounded single decode. Only push() inputs enter the codec; no reference codes."""
    limit = 384  # 30.72 s per short phrase, not a recording-duration limit.

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.parts = []
        self.total = self.peak_frames = self.decoder_calls = 0
        self.closed = False

    def push(self, chunk):
        if self.closed:
            raise RuntimeError('sentence codec already finished')
        if chunk.ndim != 2 or chunk.shape[1] != 16 or not 1 <= chunk.shape[0] <= 16:
            raise RuntimeError('expected 1..16 GENERATED frames with 16 codebooks')
        if self.total + int(chunk.shape[0]) > self.limit:
            raise RuntimeError('quality sentence exceeds 384 code frames; use shorter phrases or legacy-stream; no truncated/fallback audio')
        self.parts.append(chunk.clone())
        self.total += int(chunk.shape[0])
        self.peak_frames = self.total
        return np.zeros(0, np.float32)

    def finish(self, cancelled=False):
        import torch
        if self.closed:
            return np.zeros(0, np.float32)
        self.closed = True
        parts, self.parts = self.parts, []
        if cancelled or not parts:
            return np.zeros(0, np.float32)
        codes = torch.cat(parts, dim=0)
        self.decoder_calls += 1
        audio_list, sr = self.tokenizer.decode({'audio_codes': codes.unsqueeze(0)})
        audio = audio_list[0]
        if hasattr(audio, 'detach'):
            audio = audio.detach().float().cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if int(sr) != 24000 or len(audio) != self.total * 1920 or not np.isfinite(audio).all():
            raise RuntimeError('quality codec requires finite 24kHz PCM, exactly 1920 samples per generated frame')
        return audio.copy()


def generated_only_stream(model, *, text, language, ref_audio, ref_text, xvec_only,
                          chunk_size, max_new_tokens, temperature, top_k, top_p,
                          repetition_penalty, cancel, append_silence=False, voice_clone_prompt=None, codec_policy="windowed"):
    """Local adapter, not a global monkeypatch. Retains Faster's real CUDA graphs."""
    # Validate the ACTUAL precomputed prompt before model preparation.
    voice_clone_prompt = generation_prompt(voice_clone_prompt, ref_text, xvec_only)
    import torch
    from faster_qwen3_tts.streaming import fast_generate_streaming
    if codec_policy not in ("windowed", "sentence"):
        raise ValueError("unsupported codec policy")
    if codec_policy == "sentence" and codec_lookahead_frames() != 0:
        raise ValueError("sentence codec requires QTTS_CODEC_LOOKAHEAD_FRAMES=0; no silently ignored setting")
    if append_silence:
        raise ValueError('reference silence augmentation disabled')
    with torch.inference_mode():
        t0 = time.perf_counter()
        m, talker, config, tie, tam, tth, tpe, _reference_codes = model._prepare_generation(
            text=text, language=language, ref_audio=None, ref_text="",
            xvec_only=xvec_only, non_streaming_mode=False, append_silence=False,
            voice_clone_prompt=voice_clone_prompt, instruct=None)
        prepared_without_reference(_reference_codes)
        # No reference code is admitted even into talker context.
        window = GeneratedSentenceCodec(m.speech_tokenizer) if codec_policy == "sentence" else GeneratedCodecWindow(m.speech_tokenizer, lookahead=codec_lookahead_frames())
        it = fast_generate_streaming(
            talker=talker, talker_input_embeds=tie, attention_mask=tam,
            trailing_text_hiddens=tth, tts_pad_embed=tpe, config=config,
            predictor_graph=model.predictor_graph, talker_graph=model.talker_graph,
            max_new_tokens=max_new_tokens, min_new_tokens=2, temperature=temperature,
            top_k=top_k, top_p=top_p, do_sample=True,
            repetition_penalty=repetition_penalty, chunk_size=chunk_size)
        prepare_ms = (time.perf_counter() - t0) * 1000
        pending_decode_ms = 0.0
        first_generated_codes_ms = None
        try:
            for codes, timing in it:
                if cancel.is_set():
                    break
                if first_generated_codes_ms is None:
                    first_generated_codes_ms = (time.perf_counter() - t0) * 1000
                if codec_policy == "sentence":
                    pending_decode_ms += float(timing.get("decode_ms", 0))
                t1 = time.perf_counter()
                audio = window.push(codes)
                report = dict(timing, prepare_ms=prepare_ms, codec_ms=(time.perf_counter()-t1)*1000,
                              codec_window_frames=window.peak_frames, lookahead_frames=getattr(window, "lookahead", 0),
                              reference_codes_decoded=0, first_generated_codes_ms=first_generated_codes_ms, generated_frames=window.total, decoder_calls=window.decoder_calls)
                if audio.size:
                    yield audio, 24000, report
                elif codec_policy == "sentence":
                    progress_report = dict(report, decode_ms=0.0)
                    yield np.zeros(0, np.float32), 24000, progress_report
            t1 = time.perf_counter()
            tail = window.finish(cancelled=cancel.is_set())
            if tail.size:
                yield tail, 24000, {'codec_ms': (time.perf_counter()-t1)*1000, 'prepare_ms': prepare_ms, 'decode_ms': pending_decode_ms, 'first_generated_codes_ms': first_generated_codes_ms, 'generated_frames': window.total, 'decoder_calls': window.decoder_calls, 'reference_codes_decoded': 0,
                                    'codec_window_frames': window.peak_frames, 'is_final': True}
        finally:
            it.close()
            window.finish(cancelled=True)
