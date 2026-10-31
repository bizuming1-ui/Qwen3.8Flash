#!/usr/bin/env python3
"""
analytics/service.py — 生产审计与统计分析服务

语言分工：Python 负责「只读的审计 / 统计 / 导出」。它不参与实时写路径，
因此不会拖慢看板；它擅长的正是文本解析、统计聚合与 JSON/CSV 输出。

数据来源：C++ 日志服务写出的 data/journal.log（以及轮转文件 journal.log.1）
每行格式：#<crc32 8位十六进制>#<json>

HTTP 接口（仅监听 127.0.0.1，由 TypeScript 网关反向代理出去）：
  GET /health             -> {"ok":true,...}
  GET /stats              -> 汇总统计（累计产量、确认次数、节拍、最近一次确认）
  GET /history?limit=50   -> 最近的确认记录（倒序）
  GET /export.csv         -> 全部确认记录 CSV 导出

启动： python3 analytics/service.py --port 7102 --dir data
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import sys
import threading
import time
import zlib
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse


# --------------------------------------------------------------------------
# 日志解析
# --------------------------------------------------------------------------

@dataclass
class Record:
    ts: int
    type: str
    rev: int
    delta: int
    total: int
    current: int
    now: int
    order_no: str
    product: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts,
            "type": self.type,
            "rev": self.rev,
            "delta": self.delta,
            "total": self.total,
            "current": self.current,
            "now": self.now,
            "order_no": self.order_no,
            "product": self.product,
        }


def _b64text(raw: str) -> str:
    if not raw or raw == "-":
        return ""
    try:
        pad = "=" * (-len(raw) % 4)
        return base64.b64decode(raw + pad).decode("utf-8", "replace")
    except Exception:
        return ""


def parse_line(line: str) -> Optional[Record]:
    """校验 CRC 并解析一条日志行；损坏返回 None。"""
    if len(line) < 11 or line[0] != "#":
        return None
    if line[9] != "#":
        return None
    try:
        expect = int(line[1:9], 16)
    except ValueError:
        return None
    payload = line[10:]
    if zlib.crc32(payload.encode("utf-8", "surrogateescape")) & 0xFFFFFFFF != expect:
        return None
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return Record(
        ts=int(obj.get("ts", 0)),
        type=str(obj.get("type", "")),
        rev=int(obj.get("rev", 0)),
        delta=int(obj.get("delta", 0)),
        total=int(obj.get("total", 0)),
        current=int(obj.get("current", 0)),
        now=int(obj.get("now", 0)),
        order_no=_b64text(str(obj.get("order_b64", ""))),
        product=_b64text(str(obj.get("product_b64", ""))),
    )


@dataclass
class Cache:
    key: Tuple[Any, ...] = ()
    records: List[Record] = field(default_factory=list)
    corrupt: int = 0


class JournalReader:
    """带 mtime 缓存的日志读取器，避免每次请求都重新解析整个文件。"""

    def __init__(self, directory: str) -> None:
        self.directory = directory
        self.lock = threading.Lock()
        self.cache = Cache()

    def _files(self) -> List[str]:
        out = []
        for name in ("journal.log.1", "journal.log"):
            p = os.path.join(self.directory, name)
            if os.path.exists(p):
                out.append(p)
        return out

    def _signature(self) -> Tuple[Any, ...]:
        sig = []
        for p in self._files():
            try:
                st = os.stat(p)
                sig.append((p, st.st_size, st.st_mtime_ns))
            except OSError:
                pass
        return tuple(sig)

    def records(self) -> Tuple[List[Record], int]:
        sig = self._signature()
        with self.lock:
            if sig == self.cache.key:
                return self.cache.records, self.cache.corrupt
            recs: List[Record] = []
            corrupt = 0
            for path in self._files():
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        for line in fh:
                            line = line.rstrip("\n")
                            if not line:
                                continue
                            rec = parse_line(line)
                            if rec is None:
                                corrupt += 1
                            else:
                                recs.append(rec)
                except OSError:
                    continue
            self.cache = Cache(key=sig, records=recs, corrupt=corrupt)
            return recs, corrupt

    def commits(self) -> List[Record]:
        recs, _ = self.records()
        return [r for r in recs if r.type == "COMMIT"]


READER: Optional[JournalReader] = None


# --------------------------------------------------------------------------
# 统计
# --------------------------------------------------------------------------

def stats_payload() -> Dict[str, Any]:
    assert READER is not None
    recs, corrupt = READER.records()
    commits = [r for r in recs if r.type == "COMMIT"]
    now_ms = int(time.time() * 1000)

    produced = sum(r.delta for r in commits)
    last = commits[-1] if commits else None
    last_any = recs[-1] if recs else None

    # 最近 10 分钟内每分钟产出（滚动节拍）
    window_start = now_ms - 10 * 60 * 1000
    recent = [r for r in commits if r.ts >= window_start]
    recent_sum = sum(r.delta for r in recent)
    window_minutes = 10.0
    if recent:
        span = max(1, (now_ms - recent[0].ts)) / 60000.0
        window_minutes = min(10.0, max(span, 1 / 6))
    rate_per_min = round(recent_sum / window_minutes, 2) if window_minutes else 0.0

    # 每小时产出柱状（最近 12 小时）
    buckets: Dict[int, int] = {}
    hour_ms = 3600 * 1000
    base = now_ms - base_off(now_ms)
    for h in range(12):
        buckets[h] = 0
    for r in commits:
        diff = base - (base % hour_ms) - (r.ts - (r.ts % hour_ms))
        idx = diff // hour_ms
        if 0 <= idx < 12:
            buckets[int(idx)] += r.delta
    hourly = [
        {
            "hour_offset": -h,
            "label": time.strftime("%H:%M", time.localtime((base - h * hour_ms) / 1000)),
            "produced": buckets[h],
        }
        for h in range(12)
    ]

    return {
        "ok": True,
        "records": len(recs),
        "commits": len(commits),
        "produced_total": produced,
        "corrupt_lines": corrupt,
        "rate_per_min": rate_per_min,
        "last_commit": last.as_dict() if last else None,
        "last_record": last_any.as_dict() if last_any else None,
        "server_time": now_ms,
        "hourly": hourly,
        "orders": _order_breakdown(commits),
    }


def base_off(now_ms: int) -> int:
    """把毫秒时间戳对齐到本地整点（配合时区偏移）。"""
    lt = time.localtime(now_ms / 1000)
    return int((lt.tm_min * 60 + lt.tm_sec) * 1000)


def _order_breakdown(commits: List[Record]) -> List[Dict[str, Any]]:
    agg: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in commits:
        key = (r.order_no, r.product)
        item = agg.setdefault(
            key, {"order_no": r.order_no, "product": r.product, "produced": 0, "count": 0}
        )
        item["produced"] += r.delta
        item["count"] += 1
    return sorted(agg.values(), key=lambda x: -x["produced"])[:20]


def history_payload(limit: int) -> Dict[str, Any]:
    assert READER is not None
    commits = READER.commits()
    tail = commits[-limit:] if limit > 0 else commits
    return {"ok": True, "total": len(commits), "items": [r.as_dict() for r in reversed(tail)]}


def csv_payload() -> str:
    assert READER is not None
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "时间",
            "生产单",
            "产品",
            "本次数量",
            "累计总数",
            "当前生产数",
            "版本号",
        ]
    )
    for r in READER.commits():
        w.writerow(
            [
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r.ts / 1000)),
                r.order_no,
                r.product,
                r.delta,
                r.total,
                r.current,
                r.rev,
            ]
        )
    return buf.getvalue()


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "BoardAnalytics/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # 静音默认日志
        sys.stderr.write("[analytics] %s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, payload: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, text: str, ctype: str, filename: str = "") -> None:
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        try:
            if url.path in ("/health", "/"):
                recs, corrupt = READER.records() if READER else ([], 0)
                self._json(
                    {
                        "ok": True,
                        "service": "analytics",
                        "language": "python",
                        "records": len(recs),
                        "corrupt": corrupt,
                        "pid": os.getpid(),
                    }
                )
            elif url.path == "/stats":
                self._json(stats_payload())
            elif url.path == "/history":
                limit = int(qs.get("limit", ["50"])[0])
                self._json(history_payload(max(1, min(limit, 2000))))
            elif url.path == "/export.csv":
                self._text(csv_payload(), "text/csv; charset=utf-8", "production-log.csv")
            else:
                self._json({"ok": False, "error": "not found"}, status=404)
        except Exception as exc:  # 保持服务不崩
            self._json({"ok": False, "error": repr(exc)}, status=500)


def main() -> int:
    global READER
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7102)
    ap.add_argument("--dir", default="data")
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    READER = JournalReader(args.dir)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    recs, corrupt = READER.records()
    print(
        f"[analytics] 监听 {args.host}:{args.port}  记录 {len(recs)} 条 (损坏 {corrupt})",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
