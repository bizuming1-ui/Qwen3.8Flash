#!/usr/bin/env python3
"""End-to-end pipeline monitor.

Calls the gateway exactly like the browser does (POST /api/speak, binary frames), then checks:
  * segment order + PCM continuity, no error frames
  * both GPUs were used, per-GPU RTF
  * stage timings (LLM first token, first segment, dispatch, first audio sent, ...)
  * a simulated real-time player (start threshold from the gateway policy) -> underrun count / max gap
Exit code 0 = all hard checks passed.

usage: e2e_check.py [--url http://127.0.0.1:7860] [--mode read|chat] [--text ...] [--profile id]
"""
import argparse
import json
import os
import struct
import sys
import time

import requests

SR = 24000
DEFAULT_TEXT = (
    "你好呀，今天过得怎么样？我刚刚想了一件有意思的事情，就是人为什么会在说话的时候换气。"
    "其实呢，这和我们的节奏有关……你说对不对？\n\n好了，我们继续聊吧。先从最简单的开始，慢慢来，不着急。"
    "等你准备好了，我们再往下深入，一步一步把事情讲清楚。"
)


def run(url, mode, text, profile, key=None, access_token=None):
    body = {"text": text, "mode": mode}
    if profile:
        body["profile"] = profile
    headers = {"X-DeepSeek-Key": key} if key else {}
    access_token = access_token or os.environ.get("QTTS_ACCESS_TOKEN")
    if not access_token:
        sys.path.insert(0,str(__import__("pathlib").Path(__file__).resolve().parent.parent / "py"))
        from access_control import load_access_token, auth_directory
        access_token=load_access_token(auth_directory(__import__("pathlib").Path(os.environ.get("QTTS_STATE",__import__("pathlib").Path(__file__).resolve().parent.parent / "state"))))
    headers["Authorization"]="Bearer "+access_token
    t0 = time.time()
    r = requests.post(url + "/api/speak", json=body, headers=headers, stream=True, timeout=(5, 180))
    if r.status_code != 200:
        print("HTTP", r.status_code, r.text[:300])
        return None
    sid = r.headers.get("X-Session-Id")
    buf = bytearray()
    ev = []  # (t, type, seg, payload_len)
    segs, stats, errors, end, policy, texts = {}, {}, [], None, None, []
    for chunk in r.iter_content(None):
        buf += chunk
        while len(buf) >= 9:
            typ, seg, ln = struct.unpack("<BII", buf[:9])
            if len(buf) < 9 + ln:
                break
            payload = bytes(buf[9:9 + ln])
            del buf[:9 + ln]
            t = time.time() - t0
            if typ == 1:
                ev.append((t, 1, seg, ln // 2))
            elif typ == 2:
                segs[seg] = json.loads(payload)
            elif typ == 3:
                texts.append(json.loads(payload)["t"])
            elif typ == 4:
                stats[seg] = json.loads(payload)
            elif typ == 5:
                end = json.loads(payload)
            elif typ == 6:
                errors.append(json.loads(payload))
            elif typ == 7:
                policy = json.loads(payload)
    return dict(sid=sid, ev=ev, segs=segs, stats=stats, errors=errors, end=end, policy=policy, texts=texts,
                wall=time.time() - t0)


def simulate_player(ev, start_s, resume_s):
    """Real-time player with hysteresis: returns (underruns, max_gap_s, total_gap_s, first_play_t)."""
    if not ev:
        return 0, 0, 0, None
    arrivals = [(t, n / SR) for t, _, _, n in ev]
    queue_s = 0.0
    playing = False
    under = 0
    gap = 0.0
    maxgap = 0.0
    cur_gap = 0.0
    first = None
    t_prev = arrivals[0][0]
    ai = 0
    t = arrivals[0][0]
    total = sum(a for _, a in arrivals)
    consumed = 0.0
    dt = 0.01
    end_t = arrivals[-1][0] + total + 30
    while t < end_t and consumed < total - 1e-6:
        while ai < len(arrivals) and arrivals[ai][0] <= t:
            queue_s += arrivals[ai][1]
            ai += 1
        all_arrived = ai >= len(arrivals)
        if not playing:
            thr = start_s if first is None else resume_s
            if queue_s >= thr or (all_arrived and queue_s > 0):
                playing = True
                if first is None:
                    first = t
                if cur_gap > 0:
                    maxgap = max(maxgap, cur_gap)
                    cur_gap = 0.0
            elif first is not None:
                gap += dt
                cur_gap += dt
        if playing:
            use = min(dt, queue_s)
            queue_s -= use
            consumed += use
            if queue_s <= 1e-9 and not all_arrived:
                playing = False
                under += 1
        t += dt
    return under, max(maxgap, cur_gap), gap, first


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7860")
    ap.add_argument("--mode", default="read")
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--profile", default="")
    ap.add_argument("--key", default="")
    ap.add_argument("--min-gpus", type=int, default=1)
    a = ap.parse_args()

    res = run(a.url, a.mode, a.text, a.profile, a.key or None)
    if not res:
        sys.exit(2)
    ev, segs, stats = res["ev"], res["segs"], res["stats"]
    ok = True

    def check(name, cond, info=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {info}")

    total_audio = sum(n for _, _, _, n in ev) / SR
    print(f"session={res['sid']} segments={len(segs)} audio={total_audio:.2f}s wall={res['wall']:.2f}s")
    order = [s for _, _, s, _ in ev]
    check("segments arrive in order", order == sorted(order))
    check("no error frames", not res["errors"], str(res["errors"][:2]))
    check("every segment has audio", bool(segs) and bool(ev) and all(any(e[2] == i for e in ev) for i in segs), f"{len(segs)} segs")
    check("end frame present", res["end"] is not None)
    gpus = {s.get("gpu") for s in stats.values()}
    check(f"GPUs used >= {a.min_gpus}", len(gpus) >= a.min_gpus, f"gpus={sorted(g for g in gpus if g is not None)}")
    anomalies = [(i, s.get("anomalies")) for i, s in stats.items() if s.get("anomalies")]
    check("no TTS anomalies", not anomalies, str(anomalies))
    if ev:
        ttfa = ev[0][0] * 1000
        print(f"  first PCM byte after {ttfa:.0f} ms")
    pol = res["policy"] or {}
    start_s = float(pol.get("start_s", 2.0))
    low_s = float(pol.get("low_s", 4.0))
    u, mg, tg, first = simulate_player(ev, start_s, max(low_s, start_s))
    first = float(first) if first is not None else float("inf")
    print(f"  simulated player: start={start_s:.1f}s first_play={first:.2f}s underruns={u} max_gap={mg:.2f}s total_gap={tg:.2f}s")
    check("simulated playback has no underrun", u == 0, f"(underruns={u})")
    if res["end"]:
        e = res["end"]
        print("  stage timeline (ms since request):")
        for k, v in sorted(e.get("timeline_ms", {}).items(), key=lambda kv: kv[1]):
            print(f"      {k:<24}{v:9.1f}")
        print(f"  overall x-realtime = {e.get('overall_rtf_x')}  (audio_s / wall_s)")
        for g, v in sorted(e.get("per_gpu", {}).items()):
            print(f"  {g}: segs={int(v.get('segments', 0))} audio={v.get('audio_s', 0):.1f}s rtf={v.get('rtf_x', 0)}x "
                  f"mean_gain={v.get('gain_db_mean')}dB first_chunk={v.get('first_chunk_ms_mean')}ms")
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
