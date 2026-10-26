"""Publish pinned completed adapters as explicit inference candidates. No GPU/load."""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import uuid
import numpy as np
from resource_limits import UploadRejected,UploadLimits
from training_codes import TrainingCodesStore
from voice_library import LibraryStore,identifier,DIGEST,text,timestamp

BINDING='trained_adapter'


def reject(message):raise UploadRejected(message,409)


def check_hash(value):
    if not isinstance(value,str) or not DIGEST.fullmatch(value):reject('a pinned adapter/Base/codes SHA256 is required')
    return value


class TrainedArtifacts:
    def __init__(self,state):
        self.state=Path(state).absolute()
        if any(p.is_symlink() for p in (self.state,*self.state.parents)):reject('symlink state path rejected')
        self.fs=LibraryStore(self.state/'training_runs')

    def read(self,path,budget):
        with self.fs._open(path) as stream:raw=stream.read(budget+1)
        if len(raw)>budget:reject('training artifact byte budget exceeded')
        return raw

    def json(self,path,budget):
        try:return json.loads(self.read(path,budget))
        except (ValueError,UnicodeError):reject('invalid training artifact JSON')

    def inspect(self,run_id,pin=None):
        identifier(run_id)
        if pin is not None:check_hash(pin)
        run=self.fs._path(run_id);checkpoint=self.fs._directory(run/'adapter')
        if {p.name for p in checkpoint.iterdir()}!={'manifest.json','adapter.safetensors','speaker.safetensors'}:reject('unexpected adapter members')
        raw=self.read(checkpoint/'manifest.json',1<<20);hashed=hashlib.sha256(raw).hexdigest()
        if pin is not None and pin!=hashed:reject('adapter manifest hash changed')
        try:
            m=json.loads(raw);request=self.json(run/'request.json',64<<10);result=self.json(run/'result.json',64<<10)
            if m['schema']!=1 or m['kind']!='qtts_lora_adapter' or result['status']!='completed' or result['job_id']!=run_id or result['rank_exit_codes']!=[0,0] or result['optimizer_execution_observed'] is not True:raise ValueError()
            if result['checkpoint_relative_directory']!='training_runs/'+run_id+'/adapter':raise ValueError()
            if m['two_rank_execution_observed'] is not True or m['optimizer_updates_observed'] is not True:raise ValueError()
            check_hash(m['base_model_sha256']);check_hash(m['codes_manifest_sha256']);identifier(m['codes_id'])
            if request['model_sha256']!=m['base_model_sha256'] or request['codes_id']!=m['codes_id'] or request['codes_sha256']!=m['codes_manifest_sha256']:raise ValueError()
            ids=m['sample_ids']
            if not isinstance(ids,list) or not 2<=len(ids)<=16 or len(set(ids))!=len(ids) or ids!=request['sample_ids']:raise ValueError()
            if request.get('confirm_data_reviewed') is not True or request.get('ack_experimental_training') is not True:raise ValueError()
            for sid in ids:identifier(sid)
            if type(m['lora_rank']) is not int or not 1<=m['lora_rank']<=32 or type(m['lora_alpha']) not in (int,float) or not math.isfinite(m['lora_alpha']) or not 0<m['lora_alpha']<=128:raise ValueError()
            if request['lora_rank']!=m['lora_rank'] or request['lora_alpha']!=m['lora_alpha']:raise ValueError()
            targets=m['target_modules']
            if not isinstance(targets,list) or not targets or len(targets)>1024 or len(set(targets))!=len(targets):raise ValueError()
            for name in targets:
                if not isinstance(name,str) or len(name)>256 or not name.startswith('talker.') or not name.endswith(('.self_attn.q_proj','.self_attn.v_proj')) or any(not (c.isalnum() or c in '._') for c in name):raise ValueError()
            reports=m['rank_reports']
            if not isinstance(reports,list) or len(reports)!=2 or {r['rank'] for r in reports}!={0,1}:raise ValueError()
            epoch_count=request['epochs']
            if type(epoch_count) is not int or not 1<=epoch_count<=100:raise ValueError()
            for r in reports:
                if r['world_size']!=2 or r['backend']!='nccl' or r['parameters_changed'] is not True or len(r['epochs'])!=epoch_count:raise ValueError()
                if sum(e['optimizer_steps'] for e in r['epochs'])<1:raise ValueError()
            for epoch in range(epoch_count):
                seen=[]
                for r in reports:
                    e=r['epochs'][epoch]
                    if e['epoch']!=epoch or not math.isfinite(e['loss_mean']) or type(e['optimizer_steps']) is not int or e['optimizer_steps']<0 or not isinstance(e['seen_ids'],list):raise ValueError()
                    seen+=e['seen_ids']
                if set(seen)!=set(ids):raise ValueError()
            if set(m['files'])!={'adapter.safetensors','speaker.safetensors'}:raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError,UnicodeError):reject('incomplete or inconsistent completed training record')
        payloads={}
        for name,expected in m['files'].items():
            check_hash(expected);data=self.read(checkpoint/name,128<<20)
            if hashlib.sha256(data).hexdigest()!=expected:reject('adapter tensor file hash changed')
            payloads[name]=data
        try:
            from safetensors.numpy import load
        except ImportError:raise UploadRejected('safetensors unavailable; adapter not published/loaded',503) from None
        try:
            weights=load(payloads['adapter.safetensors']);speaker=load(payloads['speaker.safetensors'])
            expected={name+suffix for name in targets for suffix in ('.lora_A','.lora_B')}
            if set(weights)!=expected or set(speaker)!={'speaker_embedding'}:raise ValueError()
            for name in targets:
                a,b=weights[name+'.lora_A'],weights[name+'.lora_B']
                if a.ndim!=2 or b.ndim!=2 or a.shape[0]!=m['lora_rank'] or b.shape[1]!=m['lora_rank'] or not 0<a.shape[1]<=16384 or not 0<b.shape[0]<=16384:raise ValueError()
            for value in [*weights.values(),speaker['speaker_embedding']]:
                if value.dtype!=np.float32 or not np.isfinite(value).all():raise ValueError()
            vector=speaker['speaker_embedding']
            if vector.ndim!=2 or vector.shape[0]!=1 or not 1<=vector.shape[1]<=8192:raise ValueError()
            digest=hashlib.sha256()
            for name,value in sorted(weights.items()):digest.update(name.encode());digest.update(value.tobytes(order='C'))
            if any(r['adapter_sha256']!=digest.hexdigest() for r in reports):raise ValueError()
        except Exception:reject('invalid adapter tensors or rank tensor digest')
        return {'run_id':run_id,'manifest_sha256':hashed,'manifest':m,'weights':weights,'speaker':vector,'checkpoint':checkpoint}

    def describe(self,run_id):
        record=self.inspect(run_id);m=record['manifest']
        return {'run_id':run_id,'adapter_manifest_sha256':record['manifest_sha256'],'base_model_sha256':m['base_model_sha256'],
                'sample_count':len(m['sample_ids']),'training_execution_recorded':True,'quality_verified':False,'inference_reload_verified':False}

    def publish(self,run_id,pin,name,acknowledged=False):
        if acknowledged is not True:raise UploadRejected('explicit unverified adapter acknowledgement required',400)
        name=text(name,80,'trained voice name');record=self.inspect(run_id,pin);m=record['manifest']
        codes=TrainingCodesStore.configured(self.state,UploadLimits.from_env())
        profiles=LibraryStore(self.state/'profiles');pid=uuid.uuid4().hex;temporary=self.state/('.trained-profile-'+pid)
        with codes.lease(m['codes_id'],m['codes_manifest_sha256']) as (directory,meta,rows):
            if meta['schema']!=2 or meta['state']!='audio_codes_prepared' or meta['checks']['tokenization_executed'] is not True:reject('fixture/legacy codes cannot publish a trained voice')
            if [s['id'] for s in meta['samples']]!=m['sample_ids']:reject('trained sample membership changed')
            reference=rows[0]['ref_audio'];matching=[row for row in rows if row['audio']==reference]
            if len(matching)!=1:reject('uniform reference has no matching transcript')
            wav=codes._read_bytes(directory/reference,codes.limits.file_bytes)
            binding={'run_id':run_id,'manifest_sha256':pin,'base_model_sha256':m['base_model_sha256'],
                     'codes_id':m['codes_id'],'codes_manifest_sha256':m['codes_manifest_sha256']}
            profile={'id':pid,'name':name,'created':timestamp(),'language':'Auto','anchor':'anchor.wav','ref_text':matching[0]['text'],
                     'candidates':[],'breath_files':[],'f0':None,'units_per_sec':4.5,'target_rms_dbfs':-21.,
                     'pause_clause_ms':150,'pause_sentence_ms':320,'pause_para_ms':528,'breath_level_db':-37.,
                     'gen':{'temperature':.8,'top_k':50,'top_p':1.,'repetition_penalty':1.05},BINDING:binding,
                     'quality':{'verified':False},'measurements_verified':False,'speaker_model':'saved training reference embedding',
                     'model_output_mode':'sentence-buffered','quality_verified':False,'inference_reload_verified':False}
            with profiles._global():
                temporary.mkdir(mode=0o700)
                try:
                    codes._write(temporary/'anchor.wav',wav)
                    codes._write(temporary/'profile.json',(json.dumps(profile,ensure_ascii=False,allow_nan=False)+'\n').encode())
                    self.inspect(run_id,pin) # Check pinned artifacts again before exposing profile.
                    os.rename(temporary,profiles.root/pid)
                except BaseException:
                    shutil.rmtree(temporary);raise
        return {'profile_id':pid,'name':name,'adapter_manifest_sha256':pin,'active_changed':False,
                'model_output_mode':'sentence-buffered','quality_verified':False,'inference_reload_verified':False}


def binding_of(profile):
    binding=profile.get(BINDING)
    try:
        if set(binding)!={'run_id','manifest_sha256','base_model_sha256','codes_id','codes_manifest_sha256'}:raise ValueError()
        identifier(binding['run_id']);identifier(binding['codes_id'])
        for key in ('manifest_sha256','base_model_sha256','codes_manifest_sha256'):check_hash(binding[key])
    except (TypeError,ValueError,KeyError):reject('invalid trained profile binding')
    return binding


def guard_profile(profile,supports_trained=False):
    if BINDING in profile and not supports_trained:
        reject('trained voice requires explicit qwen-adapter-buffered backend; no Base/Mock fallback')
