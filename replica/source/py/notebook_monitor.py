"""Live Notebook output bridge; no server/GPU lifecycle actions and no private URL display."""
from __future__ import annotations
import base64
import hashlib
import html
import json
import threading
import time
import urllib.request
from pathlib import Path
from access_control import gateway_headers
from diagnostic_store import snapshot
from diagnostic_training import snapshot_training


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class NotebookMonitor:
    def __init__(self, root, state, port=7860, interval=2.0, renderer=None):
        self.root, self.state = Path(root), Path(state)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("invalid gateway port")
        self.port, self.interval = port, max(1.0,float(interval))
        self.stop_event = threading.Event()
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self.renderer=renderer
        self.handle=None
        self.last_signature=""
        self.latest=None
        self.thread=None

    def collect(self):
        data={"schema":"qtts-diagnostics-v1","quality_verified":False,
              "physical_speaker_output_verified":False,"missing_sources":[],
              "local":snapshot(self.state),"training":snapshot_training(self.state)}
        try:
            url="http://127.0.0.1:%d/api/diagnostics"%self.port
            request=urllib.request.Request(url,headers=gateway_headers(url,self.state,self.port))
            with self.opener.open(request,timeout=1.5) as response:
                encoded=response.read(2*1024*1024+1)
            if len(encoded)>2*1024*1024:
                raise ValueError("diagnostic response exceeds budget")
            gateway=json.loads(encoded)
            if not isinstance(gateway,dict) or gateway.get("schema")!="qtts-diagnostics-v1":
                raise ValueError("unrecognized diagnostic schema")
            data["gateway"]=gateway
        except Exception:
            data["missing_sources"].append("gateway")
        self.latest=data
        return data

    @staticmethod
    def compact(data):
        gateway=data.get("gateway",{})
        events=[]
        for role,journal in data.get("local",{}).get("journals",{}).items():
            for event in journal.get("events",[])[-2:]:
                events.append({"role":role,**event})
        return {"schema":"qtts-diagnostics-v1","gateway_unavailable":"gateway"in data["missing_sources"],
                "active":gateway.get("active",[]),"recent_runs":gateway.get("runs",[])[-2:],
                "recent_audio_and_reference_events":events[-8:],"training":data.get("training",{}),
                "quality_verified":False,"physical_speaker_output_verified":False,
                "retention_note":"界面只展示近期摘要；完整有界报告使用网页下载脱敏JSON。未出现数据不等于通过。"}

    def render(self,data):
        compact=self.compact(data)
        encoded=json.dumps(compact,ensure_ascii=False,allow_nan=False,sort_keys=True)
        # Age/heartbeat counters change continuously. Still cap Notebook updates to one/interval.
        signature=hashlib.sha256(encoded.encode()).hexdigest()
        if signature==self.last_signature:
            return
        self.last_signature=signature
        if self.renderer:
            self.renderer(compact)
            return
        try:
            from IPython.display import HTML,display
            content="<section><h3>QTTS 全链路监听（未做真人/零噪声认证）</h3><p>RMS≠LUFS；高频/平坦度仅噪声线索；首采样消费≠物理首声。后台线程只读指标，不重启模型。</p><pre style='max-height:520px;overflow:auto;white-space:pre-wrap'>"+html.escape(encoded)+"</pre></section>"
            if self.handle is None:
                self.handle=display(HTML(content),display_id=True)
            else:
                self.handle.update(HTML(content))
        except Exception:
            # Never print HTTP errors, headers, tokens or arbitrary source logs.
            print("[QTTS监听] 活跃=%d 近期会话=%d 音频/参考事件=%d 网关可读=%s；音质未认证"%
                  (len(compact["active"]),len(compact["recent_runs"]),len(compact["recent_audio_and_reference_events"]),not compact["gateway_unavailable"]),flush=True)

    def run(self):
        while not self.stop_event.is_set():
            try:self.render(self.collect())
            except Exception:
                # The observer can fail, but never turn startup/model/training success into failure.
                print("[QTTS监听] 本轮指标读取失败；不是音质通过，现有服务未改动。",flush=True)
            self.stop_event.wait(self.interval)

    def start(self):
        if self.thread and self.thread.is_alive():
            return self
        self.thread=threading.Thread(target=self.run,name="qtts-notebook-diagnostics",daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
        if self.thread and threading.current_thread() is not self.thread:
            self.thread.join(timeout=3)
        return not self.thread or not self.thread.is_alive()

    def export(self,path=None):
        data=self.collect()
        path=Path(path or self.state/"diagnostics"/"qtts-diagnostics.json")
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(data,ensure_ascii=False,allow_nan=False,indent=2)+"\n")
        path.chmod(0o600)
        return path
