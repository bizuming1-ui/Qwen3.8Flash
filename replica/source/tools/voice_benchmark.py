#!/usr/bin/env python3
"""Explicit real resident-worker speed experiment; never claims acoustic acceptance.

Without --run: blocked/no synthesis. Does not load a third model or use CPU/Mock
as GPU evidence. Run on the actual dual-T4 machine after auditing the reference.
Outputs private generated WAVs for listening (not reference playback).
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import time
import wave
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'py'))
from qtts_common import WORKER_PORTS, STATE, load_profile, profile_dir
from voice_binding import reference_binding


def measure(url, body):
    import requests
    started = time.perf_counter()
    pcm, buf, stats = bytearray(), bytearray(), None
    with requests.post(url + '/synth', json=body, stream=True, timeout=(5, 600)) as response:
        response.raise_for_status()
        for chunk in response.iter_content(65536):
            buf.extend(chunk)
            while len(buf) >= 5:
                typ, size = struct.unpack('<BI', buf[:5])
                if size > 16 * 1024 * 1024:
                    raise RuntimeError('oversize worker frame')
                if len(buf) < 5 + size:
                    break
                payload = bytes(buf[5:5+size]); del buf[:5+size]
                if stats is not None:
                    raise RuntimeError('data after terminal stats')
                if typ == 1:
                    pcm.extend(payload)
                    if len(pcm) > 64 * 1024 * 1024:
                        raise RuntimeError('benchmark PCM budget exceeded')
                elif typ == 2:
                    stats = json.loads(payload)
                elif typ == 3:
                    raise RuntimeError('worker synthesis failed (inspect private worker log)')
                else:
                    raise RuntimeError('unknown worker frame')
    elapsed = time.perf_counter() - started
    if buf or not isinstance(stats, dict) or stats.get('failed') or stats.get('cancelled'):
        raise RuntimeError('incomplete/failed/cancelled worker stream')
    if stats.get('engine') not in ('faster-qwen3-tts', 'qwen-adapter-buffered'):
        raise RuntimeError('Mock/unknown engine cannot prove real RTF')
    if stats.get('voice_binding') != body['voice_binding'] or stats.get('anomalies'):
        raise RuntimeError('reference binding mismatch or generated-audio anomaly')
    n = stats.get('speech_samples')
    if type(n) is not int or n <= 0 or len(pcm) != (n+192)*2:
        raise RuntimeError('speech sample count must exclude lead/tail/fade padding')
    seconds = n / 24000
    reported = float(stats.get('rtf', math.inf))
    computed = float(stats.get('gen_ms', math.inf)) / 1000 / seconds
    wall = elapsed / seconds
    if not all(math.isfinite(v) and v > 0 for v in (computed, wall, reported)) or abs(computed-reported) > .0002:
        raise RuntimeError('inconsistent RTF metrics')
    return bytes(pcm), {'speech_samples': n, 'speech_seconds': seconds,
                       'wall_seconds': elapsed, 'wall_rtf': wall, 'worker_rtf': computed,
                       'first_chunk_ms': stats.get('first_chunk_ms'), 'queue_ms': stats.get('queue_ms'),
                       'model_stages': stats.get('model_stages'), 'dsp_ms': stats.get('dsp_ms'),
                       'voice_binding': stats['voice_binding'], 'gpu': stats.get('gpu')}


def run(args):
    report = {'schema': 1, 'status': 'blocked', 'speed_target': .3,
              'real_gpu_verified': False, 'voice_quality_verified': False,
              'all_user_requirements_completed': False, 'measurements': [],
              'note': 'RTF = unpadded generation/wall seconds divided by generated speech seconds. Listening still required.'}
    if not args.run:
        report['reason'] = 'Use --run explicitly on the real dual-GPU host; no CPU/Mock substitution.'
        return report
    if not 3 <= args.rounds <= 20 or not 2 <= args.chunk_size <= 16:
        raise ValueError('at least3 rounds (max20), chunk_size2..16 required')
    import requests
    prof = load_profile(args.profile)
    if not prof:
        raise ValueError('reference profile missing')
    pin = reference_binding(profile_dir(args.profile), prof)
    urls = ['http://127.0.0.1:' + str(port) for port in WORKER_PORTS]
    if len(urls) != 2 or len(set(urls)) != 2:
        raise RuntimeError('exactly two distinct resident workers required')
    health = []
    for url in urls:
        h = requests.get(url+'/health', timeout=(5, 10)); h.raise_for_status(); h = h.json()
        if not h.get('ready') or h.get('busy') or not h.get('model_loaded') or h.get('engine') != 'faster-qwen3-tts':
            raise RuntimeError('two ready idle real Faster CUDA workers required, no Mock/native comparison substitution')
        if h.get('voice_conditioning') != 'icl-generated-only-codec':
            raise RuntimeError('benchmark requires the new ICL generated-only path')
        health.append(h)
    if len({h.get('gpu') for h in health}) != 2 or {h.get('cuda_visible_devices') for h in health} != {'0', '1'}:
        raise RuntimeError('workers must each own a distinct single physical GPU0/1')
    report['real_gpu_verified'] = True
    report['devices'] = [{k: h.get(k) for k in ('gpu','engine','dtype','cuda_visible_devices','vram')} for h in health]
    out = Path(args.output).parent
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    ledger_path = out / 'measurements.jsonl'
    ledger_fd = os.open(ledger_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(ledger_fd)
    report['measurement_ledger'] = ledger_path.name
    report['prompt_warmup'] = []
    for url in urls:
        t = time.perf_counter()
        response = requests.post(url+'/profile/load', json={'profile': args.profile}, timeout=(5, 600))
        response.raise_for_status(); receipt = response.json()
        if receipt.get('voice_binding') != pin or not receipt.get('ok'):
            raise RuntimeError('warmup reference changed or profile load failed')
        report['prompt_warmup'].append({'wall_seconds': time.perf_counter()-t, 'separate_from_hot_rtf': True})
    texts = ['今天阳光温暖，我们慢慢把这件事情说清楚。请保持同一位说话人的自然语气。',
             '请准确读出这些数字：二零二六年十月二十二日，下午三点十五分，一共三十二件。',
             '这是一段较长的连贯叙述。我们既要听清楚每一个字，也要检查句与句之间的音色是否一致，不能为了速度删掉任何内容。']
    for r in range(1, args.rounds+1):
        for i, url in enumerate(urls):
            for j, text in enumerate(texts):
                if reference_binding(profile_dir(args.profile), load_profile(args.profile)) != pin:
                    raise RuntimeError('profile changed during benchmark; do not mix revisions')
                pcm, row = measure(url, {'profile': args.profile, 'text': text, 'language': 'Chinese',
                                        'seed': 17, 'chunk_size': args.chunk_size, 'voice_binding': pin,
                                        'lead_pause_ms': 0, 'tail_pause_ms': 0, 'breath': False})
                wav = out / f'round{r}-worker{i}-text{j+1}.wav'
                fd = os.open(wav, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd,'wb') as f:
                    with wave.open(f,'wb') as w:
                        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
                row.update(round=r, worker=i, text_sha256=hashlib.sha256(text.encode()).hexdigest(),
                           wav=wav.name, target_passed=row['worker_rtf'] <= .3 and row['wall_rtf'] <= .3)
                report['measurements'].append(row)
                # Retain completed slow/failed-target rows if a later request fails.
                with ledger_path.open('a') as ledger:
                    ledger.write(json.dumps(row, ensure_ascii=False) + '\n')
                    ledger.flush(); os.fsync(ledger.fileno())
    report['speed_target_passed'] = all(row['target_passed'] for row in report['measurements'])
    report['status'] = 'measured-speed-only' if report['speed_target_passed'] else 'target-not-met'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true'); parser.add_argument('--profile', default='')
    parser.add_argument('--rounds', type=int, default=3); parser.add_argument('--chunk-size', type=int, default=8)
    parser.add_argument('--output', default=str(STATE/'benchmarks/step16/report.json'))
    args = parser.parse_args()
    try:
        report = run(args)
    except Exception as error:
        report = {'status': 'blocked', 'error_type': type(error).__name__,
                  'reason': 'Benchmark incomplete; inspect private host logs. No target achievement inferred.',
                  'all_user_requirements_completed': False, 'voice_quality_verified': False}
    path = Path(args.output); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Never overwrite a previous experiment, including its incomplete evidence.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2); f.write('\n')
    print(json.dumps({'status': report['status'], 'report': str(path), 'voice_quality_verified': False}))
    return 0 if report.get('speed_target_passed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
