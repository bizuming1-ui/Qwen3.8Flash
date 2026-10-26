"""Controlled two-rank training launcher, strict admission, local adapter publish.

No arbitrary commands, automatic package installs/downloads or inference shutdown.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

from gpu_ownership import GpuLease,FD_ENV,NONCE_ENV
from resource_limits import UploadLimits,UploadRejected
from training_codes import TrainingCodesStore,model_fingerprint
from voice_library import DIGEST

CODE_FD='QTTS_CODES_LEASE_FD'


def file_digest(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise UploadRejected('unsafe training asset file',409)
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1<<20),b''):h.update(block)
    return h.hexdigest()


def base_fingerprint(directory):
    directory=Path(directory).absolute()
    if any(p.is_symlink() for p in (directory,*directory.parents)) or not directory.is_dir():
        raise UploadRejected('materialized local Base directory required',400)
    records=[];size=0;folders=0
    for base,dirs,files in os.walk(directory,followlinks=False):
        folders+=1
        if folders>128 or any((Path(base)/name).is_symlink() for name in dirs):raise UploadRejected('unsafe Base directory tree',400)
        for name in sorted(files):
            path=Path(base)/name;info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or (path.suffix not in ('.json','.txt','.safetensors','.model','.tiktoken','.jinja','.md') and name!='.gitattributes'):
                raise UploadRejected('unsupported Base asset; pickle/remote code rejected',400)
            size+=info.st_size
            if size>12<<30 or len(records)>=4096:raise UploadRejected('Base model tree budget exceeded',413)
            if path.suffix=='.json':
                if info.st_size>32<<20:raise UploadRejected('Base JSON budget exceeded',413)
                try:
                    data=json.loads(path.read_bytes())
                    if not isinstance(data,dict) or 'auto_map' in data:raise ValueError()
                except (ValueError,TypeError):raise UploadRejected('unsafe Base JSON',400) from None
            records.append({'path':path.relative_to(directory).as_posix(),'bytes':info.st_size,'sha256':file_digest(path)})
    members={r['path'] for r in records}
    required={'config.json','generation_config.json','tokenizer_config.json','speech_tokenizer/config.json'}
    if not required<=members or not any(p.endswith('.safetensors') and '/' not in p for p in members):
        raise UploadRejected('incomplete Base materialization',400)
    for record in records:
        if record['path'].endswith('.index.json'):
            mapping=json.loads((directory/record['path']).read_bytes()).get('weight_map')
            if not isinstance(mapping,dict) or not mapping or any(not isinstance(p,str) or p not in members or not p.endswith('.safetensors') for p in mapping.values()):
                raise UploadRejected('Base shard index references unsafe or missing weights',400)
    cfg=json.loads((directory/'config.json').read_bytes())
    if cfg.get('model_type')!='qwen3_tts' or cfg.get('tts_model_type')!='base' or cfg.get('tts_model_size')!='1b7' or cfg.get('talker_config',{}).get('num_code_groups')!=16:
        raise UploadRejected('only Qwen3-TTS Base1.7B 12Hz/16-codebook config supported',400)
    return hashlib.sha256(json.dumps(sorted(records,key=lambda x:x['path']),sort_keys=True,separators=(',',':')).encode()).hexdigest()


def admit(meta,rows,reviewed,experimental):
    if not reviewed or not experimental:raise UploadRejected('explicit data review and experimental training acknowledgement required',400)
    if meta['schema']!=2 or meta['state']!='audio_codes_prepared' or meta['engine']['kind']!='qwen3_tts_tokenizer_12hz' or meta['checks']['tokenization_executed'] is not True:
        raise UploadRejected('training rejects fixture codes and legacy/unsealed sources',409)
    if len(rows)<2:raise UploadRejected('two distinct samples required for two-rank training',400)


def validate_options(args):
    for name,low,high in [('epochs',1,100),('accumulation',1,64),('max_sequence',64,2048),('lora_rank',1,32),('seed',0,2147483647),('timeout',1,21600)]:
        value=getattr(args,name)
        if type(value) is not int or not low<=value<=high:raise UploadRejected('invalid '+name+' budget',400)
    if not math.isfinite(args.lr) or not 0<args.lr<=1e-3 or not math.isfinite(args.lora_alpha) or not 0<args.lora_alpha<=128:
        raise UploadRejected('invalid learning rate or LoRA alpha',400)
    if not DIGEST.fullmatch(args.model_sha256):raise UploadRejected('pinned Base hash required',400)


def write_json(path,value):
    raw=json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True).encode()+b'\n'
    temporary=path.with_name('.'+path.name+'.'+uuid.uuid4().hex)
    try:
        with open(temporary,'xb') as stream:
            os.chmod(temporary,0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def child_environment(gpu,code_fd):
    env=dict(os.environ)
    for key in (FD_ENV,NONCE_ENV,CODE_FD,'QTTS_ACCESS_TOKEN','DEEPSEEK_API_KEY','HF_TOKEN','HUGGING_FACE_HUB_TOKEN','KAGGLE_USERNAME','KAGGLE_KEY','PYTHONPATH'):
        env.pop(key,None)
    env.update(gpu.export());env[CODE_FD]=str(code_fd)
    env.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',QTTS_MOCK='0',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2',TOKENIZERS_PARALLELISM='false',TORCH_NCCL_ASYNC_ERROR_HANDLING='1')
    return env


def stop_ranks(processes):
    # Separate sessions; never pkill or signal a PID from a saved stale file.
    for process in processes:
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
    deadline=time.monotonic()+3
    for process in processes:
        try:process.wait(timeout=max(.01,deadline-time.monotonic()))
        except subprocess.TimeoutExpired:pass
    for process in processes:
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
    for process in processes:process.wait(timeout=5)


def save_checkpoint(request,core,speaker,targets,reports):
    from safetensors.torch import save_file
    from lora_adapter import adapter_state
    run=Path(request['run_dir']);pending=run/'.checkpoint-pending';destination=run/'adapter'
    pending.mkdir(mode=0o700)
    try:
        tensors=adapter_state(core)
        if not tensors or sum(t.numel()*t.element_size() for t in tensors.values())>128<<20:raise ValueError('adapter budget exceeded')
        save_file(tensors,str(pending/'adapter.safetensors'))
        save_file({'speaker_embedding':speaker.detach().float().cpu().contiguous()},str(pending/'speaker.safetensors'))
        for path in pending.iterdir():os.chmod(path,0o600)
        all_seen={sid for report in reports for epoch in report['epochs'] for sid in epoch['seen_ids']}
        if all_seen!=set(request['sample_ids']) or {r['rank'] for r in reports}!={0,1} or not all(r['parameters_changed'] for r in reports):
            raise ValueError('incomplete rank/data/update coverage')
        meta={'schema':1,'kind':'qtts_lora_adapter','base_model_sha256':request['model_sha256'],'codes_id':request['codes_id'],
              'codes_manifest_sha256':request['codes_sha256'],'lora_rank':request['lora_rank'],'lora_alpha':request['lora_alpha'],
              'target_modules':targets,'sample_ids':request['sample_ids'],'rank_reports':reports,
              'sampling_policy':'repeat shuffled prefix to even; no drop_last', 'resume_optimizer_state_saved':False,
              'input_review':'operator-confirmed; not machine semantic/rights verification',
              'two_rank_execution_observed':True,'optimizer_updates_observed':True,'training_quality_verified':False,
              'inference_reload_verified':False,'published_to_inference':False,
              'files':{p.name:file_digest(p) for p in pending.iterdir()}}
        write_json(pending/'manifest.json',meta)
        os.rename(pending,destination)
    except BaseException:
        shutil.rmtree(pending);raise


def run_controller(args,tool):
    validate_options(args)
    codes=TrainingCodesStore.configured(args.state,UploadLimits.from_env())
    with codes.lease_with_fd(args.id,args.manifest_sha256) as (directory,meta,rows,code_fd):
        admit(meta,rows,args.confirm_data_reviewed,args.ack_experimental_training)
        model_dir=Path(args.model_dir).absolute()
        if base_fingerprint(model_dir)!=args.model_sha256:raise UploadRejected('Base model hash changed',409)
        if model_fingerprint(model_dir/'speech_tokenizer')!=meta['engine']['model_tree_sha256']:
            raise UploadRejected('Base speech tokenizer differs from acoustic-code tokenizer',409)
        if any(importlib.util.find_spec(name) is None for name in ('torch','qwen_tts','safetensors')):
            raise UploadRejected('training dependencies unavailable; no optimizer executed',503)
        with GpuLease.acquire('offline-reservation') as gpu:
            runs=Path(args.state).absolute()/'training_runs'
            codes.fs._directory(runs,create=True)
            if len(list(runs.iterdir()))>=32 or shutil.disk_usage(runs).free<512<<20:raise UploadRejected('training run storage budget reached',413)
            run=runs/uuid.uuid4().hex;run.mkdir(mode=0o700)
            request={'codes_id':args.id,'codes_sha256':args.manifest_sha256,'model_dir':str(model_dir),'model_sha256':args.model_sha256,
                     'state':str(Path(args.state).absolute()),'run_dir':str(run),'sample_ids':[s['id'] for s in meta['samples']],
                     'rendezvous':(run/'rendezvous').as_uri(),'epochs':args.epochs,'lr':args.lr,'lora_rank':args.lora_rank,
                     'lora_alpha':args.lora_alpha,'accumulation':args.accumulation,'seed':args.seed,'max_sequence':args.max_sequence,
                     'confirm_data_reviewed':True,'ack_experimental_training':True}
            write_json(run/'request.json',request)
            processes=[];outcome='failed';started=time.monotonic();handlers={}
            try:
                for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
                for rank in (0,1):
                    with open(run/f'rank{rank}.log','xb') as log:
                        os.chmod(log.name,0o600)
                        # Keep cancellation from losing a just-created child's PID.
                        mask=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGINT,signal.SIGTERM})
                        try:
                            process=subprocess.Popen([sys.executable,str(tool),'--_request',str(run/'request.json'),'--_rank',str(rank),'--_parent-pid',str(os.getpid())],
                                env=child_environment(gpu,code_fd),pass_fds=(gpu.fd,code_fd),stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                            processes.append(process)
                        finally:signal.pthread_sigmask(signal.SIG_SETMASK,mask)
                while True:
                    statuses=[p.poll() for p in processes]
                    if any(code is not None and code!=0 for code in statuses):break
                    if all(code==0 for code in statuses):outcome='completed';break
                    if time.monotonic()-started>=args.timeout:outcome='timeout';break
                    time.sleep(.1)
            except KeyboardInterrupt:outcome='cancelled'
            except Exception as error:
                outcome='failed';write_json(run/'controller-error.json',{'error_type':type(error).__name__})
            finally:
                stop_ranks(processes)
                for sig,previous in handlers.items():signal.signal(sig,previous)
            # Validate again while holding parent leases, even if children exited.
            if outcome=='completed':
                try:
                    codes.verify(args.id,args.manifest_sha256)
                    if base_fingerprint(model_dir)!=args.model_sha256 or not (run/'adapter/manifest.json').is_file():outcome='failed'
                except Exception:outcome='failed'
            receipt={'status':outcome,'job_id':run.name,'rank_exit_codes':[p.returncode for p in processes],
                     'checkpoint_relative_directory':f'training_runs/{run.name}/adapter' if outcome=='completed' else None,
                     'optimizer_execution_observed':outcome=='completed','quality_verified':False,'inference_reload_verified':False}
            write_json(run/'result.json',receipt)
            return receipt


def rank_worker(request_path,rank,parent_pid):
    from encode_training import arm_parent_death
    arm_parent_death(parent_pid)  # Before torch import/CUDA; rechecks exec race.
    signal.pthread_sigmask(signal.SIG_UNBLOCK,{signal.SIGINT,signal.SIGTERM})
    if rank not in (0,1):raise ValueError('invalid rank')
    path=Path(request_path)
    if path.is_symlink() or path.stat().st_size>64<<10:raise ValueError('invalid rank request')
    request=json.loads(path.read_bytes());codes=TrainingCodesStore.configured(request['state'],UploadLimits.from_env())
    gpu_fd=int(os.environ[FD_ENV]);code_fd=int(os.environ[CODE_FD])
    with GpuLease.adopt(gpu_fd,os.environ[NONCE_ENV],expected_kind='offline-reservation'):
        with codes.adopt_lease(request['codes_id'],request['codes_sha256'],code_fd) as (directory,meta,rows):
            admit(meta,rows,request['confirm_data_reviewed'],request['ack_experimental_training'])
            for fd in {gpu_fd,code_fd}:os.close(fd)
            from tts_training import run_rank
            run_rank(request,rank,directory,rows)
