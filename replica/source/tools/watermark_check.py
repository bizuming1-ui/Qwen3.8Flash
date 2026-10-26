#!/usr/bin/env python3
"""Dynamic-watermark monitor.

Plays a long text through the gateway with a simulated real-time client that reports telemetry
(played_s / buffered_s) exactly like the browser. Verifies:
  * the buffer never starves after the first start (no underrun)
  * the lead (produced - played) is bounded by the High watermark (+ in-flight segments), i.e. the
    scheduler really throttles instead of synthesising everything at once
  * generation does NOT chatter: counts 'pause/resume' toggles of the production rate
usage: watermark_check.py [--url ..] [--profile id] [--repeat 8]
"""
import argparse
import json
import struct
import sys
import threading
import time

import requests

SR = 24000
UNIT = ("你好呀，今天过得怎么样？我刚刚想了一件有意思的事情，就是人为什么会在说话的时候换气。"
        "其实呢，这和我们的节奏有关，你说对不对？好了，我们继续往下聊，慢慢来，不着急。\n\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7860")
    ap.add_argument("--profile", default="")
    ap.add_argument("--repeat", type=int, default=8)
    a = ap.parse_args()
    body = {"text": UNIT * a.repeat, "mode": "read"}
    if a.profile:
        body["profile"] = a.profile
    import os
    from pathlib import Path
    import sys
    root=Path(__file__).resolve().parent.parent
    sys.path.insert(0,str(root / "py"))
    from access_control import load_access_token, auth_directory
    headers={"Authorization":"Bearer "+load_access_token(auth_directory(Path(os.environ.get("QTTS_STATE",root / "state"))))}
    t0 = time.time()
    r = requests.post(a.url + "/api/speak", json=body, headers=headers, stream=True, timeout=(5, 600))
    sid = r.headers.get("X-Session-Id")
    arrivals = []  # (t, seconds)
    policy = {}
    state = {"played": 0.0, "playing": False, "start": None, "starved": 0, "buf": 0.0, "stop": False}
    produced = [0.0]
    lock = threading.Lock()

    def player():
        # real-time consumer with the same start rule as the browser (start_s), hysteresis on resume
        last = time.time()
        while not state["stop"]:
            time.sleep(0.01)
            now = time.time()
            dt = now - last
            last = now
            with lock:
                buf = produced[0] - state["played"]
                need = policy.get("start_s", 2.0) if state["start"] is None else max(policy.get("low_s", 4.0) * 0.6, 1.5)
                if not state["playing"] and buf >= need:
                    state["playing"] = True
                    if state["start"] is None:
                        state["start"] = now - t0
                if state["playing"]:
                    use = min(dt, max(buf, 0))
                    state["played"] += use
                    if buf - use <= 1e-3 and not state.get("done"):
                        state["playing"] = False
                        state["starved"] += 1
                state["buf"] = produced[0] - state["played"]

    def telemetry():
        while not state["stop"]:
            time.sleep(0.25)
            with lock:
                payload = {"session": sid, "played_s": state["played"], "buffered_s": state["buf"],
                           "state": "playing" if state["playing"] else "buffering", "urgency": 0.0,
                           "underruns": state["starved"]}
            try:
                requests.post(a.url + "/api/telemetry", json=payload, headers=headers, timeout=1)
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=player, daemon=True).start()
    threading.Thread(target=telemetry, daemon=True).start()
    buf = bytearray()
    leads = []
    n_seg = 0
    for chunk in r.iter_content(None):
        buf += chunk
        while len(buf) >= 9:
            typ, seg, ln = struct.unpack("<BII", buf[:9])
            if len(buf) < 9 + ln:
                break
            payload = bytes(buf[9:9 + ln])
            del buf[:9 + ln]
            if typ == 1:
                with lock:
                    produced[0] += ln / 2 / SR
                    leads.append((time.time() - t0, produced[0] - state["played"]))
                arrivals.append((time.time() - t0, ln / 2 / SR))
            elif typ == 7:
                policy.update(json.loads(payload))
            elif typ == 2:
                n_seg += 1
    with lock:
        state["done"] = True
    total = produced[0]
    # drain
    while state["played"] < total - 0.05 and time.time() - t0 < total * 2 + 60:
        time.sleep(0.05)
    state["stop"] = True
    max_lead = max((l for _, l in leads), default=0)
    # production-rate chatter: windows of 1 s with (almost) no arrivals while buffer is below High
    win = {}
    for t, s in arrivals:
        win[int(t)] = win.get(int(t), 0) + s
    horizon = int(arrivals[-1][0]) if arrivals else 0
    idle = [i for i in range(int(state["start"] or 0), horizon) if win.get(i, 0) < 0.05]
    toggles = sum(1 for i in range(1, horizon) if (win.get(i, 0) < 0.05) != (win.get(i - 1, 0) < 0.05))
    low = policy.get("low_s", 0)
    high = policy.get("high_s", 0)
    print(f"segments={n_seg} audio={total:.1f}s wall={time.time() - t0:.1f}s policy=low {low:.1f}/high {high:.1f}/start {policy.get('start_s')}")
    print(f"first play at {state['start']}s   starvations={state['starved']}   max_lead={max_lead:.1f}s   idle_seconds={len(idle)}   on/off toggles={toggles}")
    ok = True

    def check(name, cond, info=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {info}")

    check("no starvation after start", state["starved"] == 0)
    if total > high * 2.2 and high:
        check("lead bounded by high watermark (+2 segments)", max_lead <= high + 26, f"(max {max_lead:.1f}s vs high {high:.1f}s)")
        check("generation does not chatter (burst/pause cycle period >= ~30 s)", toggles <= 2 * (int(total / 30) + 1) + 2, f"(toggles={toggles}, one cycle = 2 toggles)")
    else:
        print("  (text too short to exercise the high watermark; use --repeat larger)")
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
