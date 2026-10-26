#!/usr/bin/env python3
"""No-install/no-download preflight. Runtime imports run in a time-bounded child.

Exit 0: device + API surface checks passed, NOT model inference/quality/training.
Exit 2: blocked or static inspection only. No model is loaded in either mode.
"""
from __future__ import annotations
import argparse
import importlib
from importlib import metadata
import inspect
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"py"))


def add(report, name, status, detail, required=True):
    report["checks"].append(dict(name=name,status=status,detail=detail,required=required))


def signature_check(report, cls, name, required_parameters):
    method=getattr(cls,name,None)
    if not callable(method):
        add(report,"api."+name,"blocked","required callable missing");return
    try:
        signature=inspect.signature(method)
        descriptor=inspect.getattr_static(cls,name)
    except (ValueError,TypeError,AttributeError):
        add(report,"api."+name,"unknown","signature cannot be inspected");return
    positional=[] if isinstance(descriptor,(staticmethod,classmethod)) else [object()]
    if name=="from_pretrained":positional.append(object())  # worker supplies MODEL_ID positionally
    try:
        signature.bind(*positional,**{parameter:None for parameter in required_parameters})
    except TypeError:
        add(report,"api."+name,"blocked","worker call shape incompatible (positional/keyword/extra required parameters)");return
    missing=set(required_parameters)-set(signature.parameters)
    if missing:
        add(report,"api."+name,"pass","accepts **kwargs; forwarding/semantics unverified: "+", ".join(sorted(missing)))
    else:
        add(report,"api."+name,"pass","worker call shape accepted; behavior untested")


def qwen_configuration_check(report):
    from qwen_compat import configuration_smoke,installed_version
    try:
        result=configuration_smoke()
        if result['status']=='installed' and result.get('configuration_smoke_passed') is True:
            add(report,'qwen_mimi_rope_cpu','pass','actual MimiConfig/default RoPE CPU smoke passed; NO model/GPU generation')
        elif result['status']=='not_applicable' and installed_version('qwen-tts-hf') is None:
            add(report,'qwen_mimi_rope_cpu','warning','HF distribution absent; legacy provider, no HF5 smoke applicable',False)
        else:
            add(report,'qwen_mimi_rope_cpu','blocked','HF compatibility smoke skipped or incomplete; refusing model startup')
    except Exception as error:
        add(report,'qwen_mimi_rope_cpu','blocked',type(error).__name__+'; configuration compatibility smoke failed, no model load')


def collect(runtime=False, expected_gpus=2, dtype="fp16"):
    native=os.environ.get("QTTS_TTS_ENGINE","faster")=="qwen-adapter-buffered"
    report={"schema":1,"mode":"runtime_surface" if runtime else "static",
            "status":"inspection_only","created_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
            "python":platform.python_version(),"checks":[],"devices":[],
            "model_loaded":False,"inference_verified":False,"training_verified":False,"performance_verified":False}
    report["requested_engine"]=os.environ.get("QTTS_TTS_ENGINE","faster")
    if report["requested_engine"] not in ("faster","qwen-adapter-buffered"):add(report,"engine","blocked","unknown explicit engine")
    if native:report["model_output_mode"]="sentence-buffered"
    add(report,"python","pass" if sys.version_info >= (3,10) else "blocked","Python >=3.10 required")
    for package,required in [("torch",True),("faster-qwen3-tts",not native),("transformers",False),("qwen-tts",False),("qwen-tts-hf",False),
                             ("fastapi",True),("uvicorn",True),("soundfile",True),("faster-whisper",False)]:
        try:
            version=metadata.version(package)
            add(report,"package."+package,"pass",version,required)
        except metadata.PackageNotFoundError:
            add(report,"package."+package,"blocked" if required else "warning","not installed",required)
        except Exception as error:
            add(report,"package."+package,"blocked" if required else "warning",type(error).__name__+" (metadata error; message redacted)",required)
    if native:
        available=any(c["name"] in ("package.qwen-tts","package.qwen-tts-hf") and c["status"]=="pass" for c in report["checks"])
        add(report,"package.qwen-provider","pass" if available else "blocked","official or HF provider required; namespace/config compatibility checked at runtime")
    add(report,"tool.ffmpeg","pass" if shutil.which("ffmpeg") else "warning",
        "available; decode behavior untested" if shutil.which("ffmpeg") else "missing; only soundfile-supported formats can be attempted",False)
    if runtime:
        try:
            torch=importlib.import_module("torch")
            if not torch.cuda.is_available():
                add(report,"cuda","blocked","CUDA unavailable")
            else:
                count=torch.cuda.device_count()
                add(report,"gpu_count","pass" if count>=expected_gpus else "blocked",f"visible={count}, required={expected_gpus}")
                for index in range(min(count,expected_gpus)):
                    props=torch.cuda.get_device_properties(index)
                    major,minor=torch.cuda.get_device_capability(index)
                    report["devices"].append({"index":index,"name":str(props.name),"capability":[major,minor],"total_memory_bytes":int(props.total_memory)})
                    supported=dtype=="fp16" or dtype=="bf16" and major>=8
                    if dtype=="fp32":supported=os.environ.get("QTTS_ALLOW_FP32")=="1"
                    add(report,f"gpu{index}.dtype","pass" if supported else "blocked",
                        f"requested={dtype}; capability={major}.{minor}; numerical stability and free VRAM untested")
        except Exception as error:
            add(report,"cuda_import","blocked",type(error).__name__+" (message redacted)")
        try:
            if native:
                backend=importlib.import_module("qwen_tts");cls=getattr(backend,"Qwen3TTSModel",None)
                qwen_configuration_check(report)
                signature_check(report,cls,"from_pretrained",["device_map","dtype","attn_implementation","local_files_only","trust_remote_code","use_safetensors"])
                signature_check(report,cls,"generate_voice_clone",["text","language","voice_clone_prompt","non_streaming_mode","max_new_tokens","temperature","top_k","top_p","repetition_penalty","stopping_criteria"])
                add(report,"buffered_output","pass","sentence-buffered only; adapter/Qwen reload and cancellation behavior not tested",False)
                return finalize(report)
            backend=importlib.import_module("faster_qwen3_tts")
            qwen_configuration_check(report)
            cls=getattr(backend,"FasterQwen3TTS",None)
            if cls is None:
                add(report,"backend_class","blocked","FasterQwen3TTS is missing")
            else:
                signature_check(report,cls,"from_pretrained",["device","dtype","attn_implementation","max_seq_len"])
                signature_check(report,cls,"warmup",["prefill_len"])
                signature_check(report,cls,"_prepare_generation",["text","language","ref_audio","ref_text","xvec_only","non_streaming_mode","append_silence","voice_clone_prompt","instruct"])
                streaming=importlib.import_module("faster_qwen3_tts.streaming")
                class StreamAPI:
                    fast_generate_streaming=staticmethod(streaming.fast_generate_streaming)
                signature_check(report,StreamAPI,"fast_generate_streaming",["talker","talker_input_embeds","attention_mask","trailing_text_hiddens","tts_pad_embed","config","predictor_graph","talker_graph","max_new_tokens","min_new_tokens","temperature","top_k","top_p","do_sample","repetition_penalty","chunk_size"])
                add(report,"private_prompt_cache","pass" if callable(getattr(cls,"_resolve_voice_clone_prompt_from_reference",None)) else "warning",
                    "private interface is version-sensitive; real prompt preparation still required",False)
        except Exception as error:
            add(report,"backend_import","blocked",type(error).__name__+" (message redacted)")
    else:
        add(report,"runtime","unknown","not requested; CUDA and API not imported")
    return finalize(report)


def finalize(report):
    checks=report["checks"]
    if any(c["required"] and c["status"] in ("blocked","unknown") for c in checks):
        report["status"]="blocked" if any(c["required"] and c["status"]=="blocked" for c in checks) else "inspection_only"
    else:report["status"]="surface_preflight_passed" if report["mode"]=="runtime_surface" else "inspection_only"
    return report


def write_report(path, report):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=path.parent,delete=False) as file:
            temporary=Path(file.name)
            json.dump(report,file,ensure_ascii=False,indent=2);file.write("\n");file.flush();os.fsync(file.fileno())
        os.replace(temporary,path)
    finally:
        if temporary is not None:temporary.unlink(missing_ok=True)


def isolated_runtime(expected_gpus, dtype, timeout):
    """Discard dependency import stdout/stderr; publish only our bounded JSON report."""
    with tempfile.TemporaryDirectory(prefix="qtts-probe-") as directory:
        output=Path(directory)/"report.json"
        command=[sys.executable,str(Path(__file__).resolve()),"--child-runtime","--expected-gpus",str(expected_gpus),"--dtype",dtype,"--output",str(output)]
        process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.wait()
            report=collect(False,expected_gpus,dtype)
            report["mode"]="runtime_surface"
            add(report,"runtime_timeout","blocked","runtime import/device inspection exceeded time budget")
            return finalize(report)
        if output.is_file() and output.stat().st_size <= 256<<10:
            try:
                report=json.loads(output.read_text())
                if isinstance(report,dict) and report.get("schema")==1 and report.get("status") in ("blocked","inspection_only","surface_preflight_passed") and isinstance(report.get("checks"),list):
                    return report
            except (ValueError,OSError):pass
        report=collect(False,expected_gpus,dtype);report["mode"]="runtime_surface"
        add(report,"runtime_child","blocked","child exited without a valid report")
        return finalize(report)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime",action="store_true")
    parser.add_argument("--child-runtime",action="store_true",help=argparse.SUPPRESS)
    parser.add_argument("--expected-gpus",type=int,choices=(1,2),default=2)
    parser.add_argument("--dtype",choices=("fp16","bf16","fp32"),default="fp16")
    parser.add_argument("--timeout",type=int,default=120)
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    if not 1<=args.timeout<=300:parser.error("timeout must be 1..300 seconds")
    report=isolated_runtime(args.expected_gpus,args.dtype,args.timeout) if args.runtime else collect(args.child_runtime,args.expected_gpus,args.dtype)
    if args.output:write_report(args.output,report)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report["status"]=="surface_preflight_passed" else 2


if __name__=="__main__":raise SystemExit(main())
