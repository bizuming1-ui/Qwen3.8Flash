"""Strict reference-context policy, NOT an ASR/voice identity certification.

No reference acoustic codes/text may condition Faster talker in this candidate.
Trained backend, codec/DSP, observers and user source archives are separate.
"""
from __future__ import annotations
import math
import os


def clone_mode():
    value = os.environ.get('QTTS_CLONE_MODE', 'xvector').strip().lower()
    if value != 'xvector':
        raise ValueError('strict candidate requires QTTS_CLONE_MODE=xvector; ICL reference content is not admitted')
    return value


def speaker_prompt(prompt):
    """Reject an ICL/cache mismatch, do NOT silently strip its fields and claim success.
    Return an owned embedding snapshot preserving the actual torch device/dtype.
    """
    import torch
    fields = {'ref_code', 'ref_spk_embedding', 'x_vector_only_mode', 'icl_mode'}
    if type(prompt) is not dict or set(prompt) != fields:
        raise ValueError('strict prompt requires exactly four explicit conditioning fields')
    if any(type(prompt[k]) is not list or len(prompt[k]) != 1 for k in fields):
        raise ValueError('strict prompt requires one item per field')
    if prompt['ref_code'][0] is not None or prompt['icl_mode'][0] is not False or prompt['x_vector_only_mode'][0] is not True:
        raise ValueError('reference acoustic codes/ICL flags are forbidden, including stale cached prompts')
    vector = prompt['ref_spk_embedding'][0]
    if not torch.is_tensor(vector) or not vector.is_floating_point() or vector.ndim != 1 or not 1 <= vector.numel() <= 16384:
        raise ValueError('invalid bounded one-dimensional speaker tensor')
    if not bool(torch.isfinite(vector).all().item()):
        raise ValueError('non-finite speaker tensor')
    peak = float(vector.detach().abs().max().item())
    if not math.isfinite(peak) or peak <= 0:
        raise ValueError('zero/invalid speaker tensor')
    return {'ref_code': [None], 'ref_spk_embedding': [vector.detach().clone()],
            'x_vector_only_mode': [True], 'icl_mode': [False]}


def resolved_speaker_prompt(prompt, ref_ids, using_icl):
    if using_icl is not False or type(ref_ids) is not list or len(ref_ids) != 1 or ref_ids[0] is not None:
        raise ValueError('resolver returned reference text tokens or ICL despite strict speaker-only policy')
    return speaker_prompt(prompt)


def generation_prompt(prompt, ref_text, xvec_only):
    clone_mode()
    if ref_text != '' or xvec_only is not True:
        raise ValueError('strict generation forbids reference text and requires explicit speaker-only')
    return speaker_prompt(prompt)


def prepared_without_reference(reference_codes):
    if reference_codes is not None:
        raise ValueError('prepare returned reference codes; stopped before acoustic token generation')


def normalized_embedding(value):
    import numpy as np
    a = np.asarray(value)
    if a.ndim != 1 or not 1 <= a.size <= 16384 or a.dtype.kind not in 'fiu' or not np.isfinite(a).all():
        raise ValueError('invalid speaker embedding')
    a = a.astype(np.float64)
    scale = float(np.max(np.abs(a)))
    if not math.isfinite(scale) or scale == 0:
        raise ValueError('zero speaker embedding')
    a = a / scale
    norm = float(np.linalg.norm(a))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError('invalid speaker norm')
    return a / norm


def speaker_triplet(owner, reference, gpu0, gpu1):
    """Existing ECAPA ONLY, never auto-load/download; values are not pass thresholds."""
    import numpy as np
    unavailable = {'speaker_metric_available': False, 'reference_speaker_metric_available': False,
                   'speaker_identity_verified': False}
    if owner.MOCK or owner.SPK.method != 'ecapa' or owner.SPK.enc is None:
        return unavailable
    encoder = owner.SPK.enc
    try:
        embeddings = []
        for pcm in (reference, gpu0, gpu1):
            a = np.asarray(pcm)
            # Do not let padding a tiny clip manufacture a confident reference metric.
            if a.ndim != 1 or not 24000 <= a.size <= 24000 * 60 or a.dtype.kind not in 'fiu' or not np.isfinite(a).all() or not np.any(a):
                return unavailable
            embeddings.append(normalized_embedding(owner.SPK.embed(owner.to16k(a.copy()))))
            if owner.SPK.method != 'ecapa' or owner.SPK.enc is not encoder:
                return unavailable
        r, a, b = embeddings
        if r.shape != a.shape or r.shape != b.shape:
            return unavailable
        def cosine(x, y): return float(np.clip(np.dot(x, y), -1., 1.))
        return {**unavailable, 'speaker_metric_available': True, 'reference_speaker_metric_available': True,
                'speaker_cosine': cosine(a, b), 'reference_cosine_gpu0': cosine(r, a),
                'reference_cosine_gpu1': cosine(r, b)}
    except Exception:
        # No raw exception, reference text, file path, waveform or vector in diagnostics.
        return unavailable


def pair_pin(a, b, binding, mock):
    """Protocol comparability only; never a physical GPU or voice identity verdict."""
    if mock or type(a) is not dict or type(b) is not dict or type(binding) is not str or len(binding) != 64 or any(c not in '0123456789abcdef' for c in binding):
        return False
    for row, gpu in ((a, 0), (b, 1)):
        if any(type(row.get(k)) is not int or row[k] != v for k, v in [('gpu', gpu), ('seed', 1), ('chunk_size', 4)]):
            return False
        if row.get('voice_binding') != binding or row.get('failed') or row.get('cancelled'):
            return False
        if type(row.get('engine')) is not str or row['engine'] not in ('faster-qwen3-tts', 'qwen-adapter-buffered'):
            return False
        if row.get('dtype') not in ('fp16', 'bf16', 'fp32'):
            return False
        mode = 'trained-speaker-vector' if row['engine'] == 'qwen-adapter-buffered' else 'speaker-vector-only'
        if row.get('voice_conditioning') != mode:
            return False
        policy = row.get('quality_policy')
        if policy not in ('legacy-stream', 'sentence-linear', 'sentence-agc', 'sentence-agc-headroom', 'windowed-linear'):
            return False
        codec = 'adapter-native' if row['engine'] == 'qwen-adapter-buffered' else 'sentence' if policy in ('sentence-linear', 'sentence-agc', 'sentence-agc-headroom') else 'windowed'
        if row.get('codec_policy') != codec:
            return False
        level = row.get('output_target_dbfs')
        if type(level) not in (int, float) or not math.isfinite(level):
            return False
    for key in ('engine', 'dtype', 'voice_conditioning', 'output_target_dbfs', 'quality_policy', 'codec_policy'):
        if a.get(key) != b.get(key):
            return False
    return True


def reference_audio(owner, profile, expected_binding):
    """Read only the bound regular anchor, only for an already loaded ECAPA."""
    if owner.MOCK or owner.SPK.method != 'ecapa' or owner.SPK.enc is None:
        return None
    try:
        import io
        import soundfile as sf
        raw = owner.regular_bytes(owner.profile_dir(profile['id']) / owner.safe_name(profile['anchor']))
        import hashlib
        import struct
        from voice_binding import DOMAIN, generation_bytes
        digest = hashlib.sha256(DOMAIN)
        for value in (raw, str(profile.get('ref_text') or '').encode('utf-8'), str(profile.get('language') or '').encode('utf-8'), generation_bytes(profile)):
            digest.update(struct.pack('<Q', len(value))); digest.update(value)
        if digest.hexdigest() != expected_binding:
            return None  # Bind the bytes actually decoded, not just before/after path reads.

        with sf.SoundFile(io.BytesIO(raw)) as f:
            if f.channels != 1 or not 8000 <= f.samplerate <= 192000 or not 1 <= f.frames / f.samplerate <= 30.72:
                return None
        return owner.decode_audio(raw, 'reference')
    except Exception:
        return None
