"""Explicit opt-in paired inference. No automatic GPU work or audio export."""
import json
import math
import time
import uuid
import numpy as np
from fastapi import Request
from fastapi.responses import JSONResponse
from resource_limits import UploadRejected
from diagnostic_audio import safe_observe
from diagnostic_store import best_effort, clean, snapshot
from diagnostic_training import snapshot_training
from reference_guard import speaker_triplet, reference_audio, pair_pin


def paired_features(a, b):
    n = min(len(a), len(b))
    correlation = None
    if n >= 1024:
        x, y = a[:n].astype(np.float64), b[:n].astype(np.float64)
        x -= x.mean(); y -= y.mean()
        denominator = float(np.linalg.norm(x)*np.linalg.norm(y))
        if denominator > 1e-12:
            correlation = float(np.clip(np.dot(x,y)/denominator,-1,1))
    return {"waveform_identical": bool(np.array_equal(a,b)), "waveform_lag0_correlation": correlation,
            "waveform_compared_samples": n, "speaker_identity_verified": False, "quality_verified": False}


def collect(owner, index, body):
    import requests
    import struct
    # Hard PCM/frame/wall budgets; closing a response propagates cancellation to /synth.
    pcm, pending, stats, ended = bytearray(), bytearray(), {}, False
    started = time.monotonic()
    with requests.post(owner.WORKERS[index]+"/synth", json=body, stream=True, timeout=(5,120)) as response:
        if response.status_code != 200:
            raise RuntimeError("paired worker unavailable")
        for chunk in response.iter_content(65536):
            if time.monotonic()-started > 240:
                raise RuntimeError("paired inference timed out")
            pending.extend(chunk)
            while len(pending) >= 5:
                kind, length = struct.unpack("<BI",pending[:5])
                if length > 4*1024*1024:
                    raise RuntimeError("paired frame budget exceeded")
                if len(pending) < 5+length:
                    break
                payload=bytes(pending[5:5+length]);del pending[:5+length]
                if kind == 1:
                    if ended or len(payload)%2 or len(pcm)+len(payload)>24000*2*60:
                        raise RuntimeError("paired PCM budget/protocol rejected")
                    pcm.extend(payload)
                elif kind == 2:
                    if ended or len(payload)>262144:
                        raise RuntimeError("paired stats protocol rejected")
                    stats=json.loads(payload);ended=True
                else:
                    raise RuntimeError("paired worker failed")
    if pending or not ended or not pcm or not isinstance(stats,dict) or stats.get("failed") or stats.get("cancelled"):
        raise RuntimeError("paired inference incomplete")
    return np.frombuffer(bytes(pcm),dtype='<i2').astype(np.float32)/32768.0,stats


def compare(owner, values):
    if not owner.ADMISSION.slot.acquire(blocking=False):
        raise UploadRejected("reference processing is busy; retry when idle",429)
    pid, text, language = values
    identifier=uuid.uuid4().hex
    started=time.monotonic()
    try:
        if len(owner.WORKERS)!=2:
            raise UploadRejected("paired test requires two workers",409)
        profile=owner.load_profile(pid)
        if not profile:
            raise UploadRejected("select an existing voice profile",404)
        binding=owner.reference_binding(owner.profile_dir(pid),profile,allow_missing=owner.MOCK)
        if not binding:
            raise UploadRejected("no immutable reference binding",409)
        reference = reference_audio(owner, profile, binding)
        if owner.reference_binding(owner.profile_dir(pid),profile,allow_missing=owner.MOCK)!=binding:
            raise UploadRejected("reference changed before paired inference",409)
        import requests
        for worker in owner.WORKERS:
            response=requests.get(worker+"/health",timeout=3)
            health=response.json() if response.status_code==200 else {}
            if health.get("busy") or not health.get("ready"):
                raise UploadRejected("workers must be ready and idle for a paired test",409)
        best_effort("pair",{"id":identifier,"kind":"pair_test","status":"running","quality_verified":False})
        body={"profile":pid,"text":text,"language":language,"seed":1,"chunk_size":4,
              "lead_pause_ms":0,"tail_pause_ms":0,"breath":False,"voice_binding":binding,
              "diagnostic_session":identifier,"diagnostic_segment":0}
        a,sa=collect(owner,0,body)
        body["diagnostic_segment"]=1
        b,sb=collect(owner,1,body)
        current=owner.load_profile(pid)
        if not current or owner.reference_binding(owner.profile_dir(pid),current,allow_missing=owner.MOCK)!=binding:
            raise UploadRejected("profile changed during paired test; no valid comparison",409)
        da,db=safe_observe(a),safe_observe(b)
        same_binding=sa.get("voice_binding")==binding and sb.get("voice_binding")==binding
        same_engine=sa.get("engine") in ("faster-qwen3-tts","qwen-adapter-buffered") and sa.get("engine")==sb.get("engine")
        same_dtype=sa.get("dtype") in ("fp16","bf16","fp32") and sa.get("dtype")==sb.get("dtype")
        distinct=type(sa.get("gpu")) is int and type(sb.get("gpu")) is int and sa.get("gpu")==0 and sb.get("gpu")==1
        result={"id":identifier,"kind":"pair_test","status":"done", "elapsed_s":time.monotonic()-started,
                "same_text":True,"same_seed":type(sa.get("seed")) is int and type(sb.get("seed")) is int and sa.get("seed")==1 and sb.get("seed")==1,
                "same_binding":same_binding,"same_engine":same_engine,"same_dtype":same_dtype,
                "distinct_gpu_labels":distinct,"physical_identity_verified":False,
                "observed_pair_valid":pair_pin(sa,sb,binding,owner.MOCK),
                "gpu0":{**sa,"diagnostics":da},"gpu1":{**sb,"diagnostics":db},**paired_features(a,b),
                "output_dbfs_delta":None if "rms_dbfs"not in da or "rms_dbfs"not in db else da["rms_dbfs"]-db["rms_dbfs"],
                "output_high_band_delta":None if da.get("high_band_fraction_mean")is None or db.get("high_band_fraction_mean")is None else da["high_band_fraction_mean"]-db["high_band_fraction_mean"],
                "speaker_metric_available":False}
        result.update(speaker_triplet(owner,reference,a,b))
        current=owner.load_profile(pid)
        if not current or owner.reference_binding(owner.profile_dir(pid),current,allow_missing=owner.MOCK)!=binding:
            raise UploadRejected("profile changed during reference embedding; no valid comparison",409)
        result=clean(result)
        best_effort("pair",result)
        return result
    except Exception:
        best_effort("pair",{"id":identifier,"kind":"pair_test","status":"failed","elapsed_s":time.monotonic()-started,"quality_verified":False})
        raise
    finally:
        owner.ADMISSION.slot.release()


def register_diagnostics(app,owner):
    @app.get("/diagnostics/snapshot")
    async def diagnostic_snapshot():
        def read():
            data=snapshot(owner.STATE);data["training"]=snapshot_training(owner.STATE)
            return data
        return await owner.HEAVY.run(read)

    @app.post("/diagnostics/pair")
    async def diagnostic_pair(request:Request):
        raw=bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>4096:
                raise UploadRejected("paired input budget exceeded",413)
        def unique(pairs):
            result={}
            for k,v in pairs:
                if k in result:raise ValueError("duplicate field")
                result[k]=v
            return result
        try:
            data=json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
        except (ValueError,UnicodeError):
            raise UploadRejected("invalid paired-test JSON",400) from None
        if not isinstance(data,dict) or set(data)-{"profile","text","language"} or not {"profile","text"}<=set(data):
            raise UploadRejected("invalid paired-test fields",400)
        pid,text,language=data.get("profile"),data.get("text"),data.get("language","Auto")
        if not isinstance(pid,str) or not isinstance(text,str) or not text.strip() or len(text)>200:
            raise UploadRejected("paired test needs an existing profile and 1–200 characters of your text",400)
        try:owner.profile_dir(pid)
        except (ValueError,TypeError):raise UploadRejected("invalid profile id",400) from None
        if not isinstance(language,str) or language not in {"Auto","Chinese","English","Japanese","Korean","German","French","Spanish","Russian","Portuguese","Italian"}:
            raise UploadRejected("invalid paired language",400)
        try:
            return await owner.HEAVY.run(compare,owner,(pid,text.strip(),language))
        except UploadRejected:
            raise
        except Exception:
            return JSONResponse({"status":"failed","quality_verified":False,"error":"paired test incomplete; inspect sanitized diagnostics"},status_code=503)
