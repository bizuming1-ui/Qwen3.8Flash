#!/usr/bin/env python3
"""Local CPU-only acoustic-code CLI. No HTTP endpoint or download/install mode."""
from __future__ import annotations
import argparse
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--_report',help=argparse.SUPPRESS)
    p.add_argument('--_parent-pid',type=int,help=argparse.SUPPRESS)
    sub=p.add_subparsers(dest='operation',required=True)
    for name in ('fingerprint','encode','list','verify','delete','hold-read'):
        s=sub.add_parser(name)
        if name in ('fingerprint','encode'):s.add_argument('--model-dir',required=True)
        if name!='fingerprint':s.add_argument('--state',required=True)
        if name in ('encode','verify','delete','hold-read'):
            s.add_argument('--id',required=True);s.add_argument('--manifest-sha256',required=True)
        if name=='encode':s.add_argument('--model-sha256',required=True)
        if name=='hold-read':s.add_argument('--seconds',type=int,required=True)
        s.add_argument('--timeout',type=int,default=1800)
    return p


def operation(args):
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'py'))
    from resource_limits import UploadLimits
    from training_codes import TrainingCodesStore,QwenCPUEncoder,model_fingerprint
    from training_data import TrainingDataStore
    if args.operation=='fingerprint':return {'model_tree_sha256':model_fingerprint(args.model_dir),'model_loaded':False}
    limits=UploadLimits.from_env();codes=TrainingCodesStore.configured(args.state,limits)
    if args.operation=='list':return codes.list()
    if args.operation=='verify':return codes.verify(args.id,args.manifest_sha256)
    if args.operation=='delete':return codes.delete(args.id,args.manifest_sha256)
    if args.operation=='hold-read':
        import threading
        with codes.lease(args.id,args.manifest_sha256) as (_,meta,rows):
            threading.Event().wait(args.seconds)
            return {'id':meta['id'],'state':meta['state'],'schema':meta['schema'],'sample_count':len(rows),
                    'read_lease_completed':True,'source_provenance_policy':'sealed-source-v1' if meta['schema']==2 else 'legacy-unsealed',
                    'training_allowed':False,'gpu_verified':False,'training_verified':False}
    inputs=TrainingDataStore.configured(args.state,limits)
    return codes.prepare(inputs,args.id,args.manifest_sha256,lambda:QwenCPUEncoder(args.model_dir,args.model_sha256))


def arm_parent_death(expected_pid):
    """Linux: orphaned encoder cannot outlive a SIGKILLed controller.

    Recheck ppid AFTER prctl to close the fork/exec/arming race. Production
    encoder is single-process (CPU threads), no external process launcher.
    """
    if sys.platform!='linux' or not expected_pid:raise RuntimeError('Linux controller handshake required')
    import ctypes
    libc=ctypes.CDLL(None,use_errno=True)
    libc.prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
    if libc.prctl(1,signal.SIGKILL,0,0,0)!=0:raise OSError('parent-death signal unavailable')
    if os.getppid()!=expected_pid:os.kill(os.getpid(),signal.SIGKILL)


def worker(args):
    # Third-party loader logs never become a public transcript/error channel.
    with open(os.devnull,'w') as sink,contextlib.redirect_stdout(sink),contextlib.redirect_stderr(sink):
        try:
            arm_parent_death(args._parent_pid)
            result={'status':'ok','operation':args.operation,'result':operation(args)};code=0
        except Exception as error:
            sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'py'))
            from resource_limits import UploadRejected
            if isinstance(error,UploadRejected):
                result={'status':'blocked' if error.code==503 else 'rejected','operation':args.operation,'reason':str(error),'code':error.code}
            else:result={'status':'failed','operation':args.operation,'reason':'operation failed; inspect local store before retry'}
            code=2
    with open(args._report,'w',encoding='utf-8') as stream:
        os.chmod(args._report,0o600);json.dump(result,stream,ensure_ascii=False,allow_nan=False)
    return code


def terminate(process):
    if process.poll() is not None:return
    try:os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError:return
    try:process.wait(timeout=3)
    except subprocess.TimeoutExpired:pass
    # The group can outlive its leader; kill remaining descendants as well.
    try:os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    process.wait(timeout=5)


def main(argv=None):
    argv=sys.argv[1:] if argv is None else argv
    args=parser().parse_args(argv)
    if not 1<=args.timeout<=3600:parser().error('timeout must be 1..3600 seconds')
    if args.operation=='hold-read' and not 1<=args.seconds<=3600:parser().error('seconds must be 1..3600')
    if args._report:return worker(args)
    env=dict(os.environ)
    for key in ('QTTS_GPU_LEASE_FD','QTTS_GPU_LEASE_NONCE','QTTS_ACCESS_TOKEN','DEEPSEEK_API_KEY','HF_TOKEN','HUGGING_FACE_HUB_TOKEN','KAGGLE_USERNAME','KAGGLE_KEY'):env.pop(key,None)
    env.update({'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','CUDA_VISIBLE_DEVICES':'','OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2'})
    old=signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    process=None
    try:
        with tempfile.TemporaryDirectory(prefix='qtts-code-task-') as directory:
            report=Path(directory)/'result.json'
            process=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--_report',str(report),'--_parent-pid',str(os.getpid()),*argv],
                                     env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            try:code=process.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                terminate(process)
                print(json.dumps({'status':'timeout','reason':'deadline exceeded; list/verify before retry in case publication already committed'}));return 2
            if not report.is_file() or report.stat().st_size>1<<20:
                print(json.dumps({'status':'failed','reason':'worker exited without a bounded receipt; inspect local store'}));return 2
            print(report.read_text(encoding='utf-8'));return 0 if code==0 else 2
    except KeyboardInterrupt:
        if process is not None:terminate(process)
        print(json.dumps({'status':'cancelled','reason':'process group stopped; list/verify before retry in case publication already committed'}));return 130
    finally:
        if process is not None:terminate(process)
        signal.signal(signal.SIGTERM,old)


if __name__=='__main__':raise SystemExit(main())
