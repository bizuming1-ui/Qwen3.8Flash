"""Transactional offline acoustic codes. No GPU, text tokenizer or trainer.

Injected test encoders ALWAYS publish test_only, never real execution evidence.
"""
from __future__ import annotations

from contextlib import contextmanager
import importlib.metadata
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import stat
import uuid

import numpy as np
from resource_limits import UploadRejected, positive_env
from training_data import TrainingDataStore, SR, UPSTREAM, canonical_wav, digest, encode, rank_plan
from voice_library import DIGEST, identifier, timestamp


def model_fingerprint(directory):
    """Materialized local files only: no HF snapshot symlinks or pickle loaders."""
    directory=Path(directory).absolute()
    for parent in (directory,*directory.parents):
        if parent.is_symlink():raise UploadRejected("model directory must not contain symlinks",400)
    if not directory.is_dir():raise UploadRejected("local materialized tokenizer model is missing",400)
    records=[];total=0;directories=0
    for base,dirs,files in os.walk(directory,followlinks=False):
        directories+=1
        if directories>128:raise UploadRejected("model directory budget exceeded",413)
        if any((Path(base)/name).is_symlink() for name in dirs):raise UploadRejected("model symlink rejected",400)
        for name in sorted(files):
            path=Path(base)/name;info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or path.suffix not in (".json",".safetensors"):
                raise UploadRejected("only regular JSON/safetensors model files are allowed",400)
            total+=info.st_size
            if total>4<<30 or len(records)>=512:raise UploadRejected("model file budget exceeded",413)
            with open(path,"rb") as stream:
                import hashlib
                sha=hashlib.sha256()
                for block in iter(lambda:stream.read(1<<20),b""):sha.update(block)
            records.append({"path":path.relative_to(directory).as_posix(),"bytes":info.st_size,"sha256":sha.hexdigest()})
    if not records or not any(r["path"].endswith('.safetensors') for r in records):
        raise UploadRejected("local safetensors weights are required",400)
    config=directory/'config.json'
    if not config.is_file() or config.stat().st_size>1<<20:raise UploadRejected("bounded tokenizer config required",400)
    try:
        cfg=json.loads(config.read_bytes())
        if cfg.get('model_type')!='qwen3_tts_tokenizer_12hz':raise ValueError()
        for key,value in {'input_sample_rate':24000,'output_sample_rate':24000,'encode_downsample_rate':1920,'decode_upsample_rate':1920,'encoder_valid_num_quantizers':16}.items():
            if key in cfg and (type(cfg[key]) is not int or cfg[key]!=value):raise ValueError()
        for key in ('encoder_config','decoder_config'):
            nested=cfg.get(key,{})
            if not isinstance(nested,dict) or type(nested.get('codebook_size',2048)) is not int or nested.get('codebook_size',2048)!=2048:raise ValueError()
            if key=='decoder_config' and (type(nested.get('num_quantizers',16)) is not int or nested.get('num_quantizers',16)!=16):raise ValueError()
    except (ValueError,AttributeError,TypeError):raise UploadRejected("incompatible 12Hz tokenizer config",400) from None
    names={r['path'] for r in records}
    for record in records:
        if record['path'].endswith('.json'):
            path=directory/record['path']
            if path.stat().st_size>1<<20:raise UploadRejected('model JSON budget exceeded',413)
            try:
                value=json.loads(path.read_bytes())
                if not isinstance(value,dict) or 'auto_map' in value:raise ValueError()
                if record['path'].endswith('.index.json'):
                    mapping=value.get('weight_map')
                    if not isinstance(mapping,dict) or not mapping or any(not isinstance(v,str) or v not in names or not v.endswith('.safetensors') for v in mapping.values()):raise ValueError()
            except (ValueError,TypeError):raise UploadRejected('invalid or unsafe model JSON/index',400) from None
    return digest(encode(sorted(records,key=lambda r:r['path'])))


class QwenCPUEncoder:
    """Only production adapter; lazy imports, local offline FP32/eager CPU only."""
    def __init__(self,model_dir,expected_hash):
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):raise UploadRejected("pinned tokenizer model hash required",400)
        self.directory=Path(model_dir).absolute();self.expected_hash=expected_hash
        if model_fingerprint(self.directory)!=expected_hash:raise UploadRejected("tokenizer model hash changed",409)
        os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
        try:
            import torch
            from qwen_tts import Qwen3TTSTokenizer
            from qwen_compat import install_qwen_rope_bridge
            install_qwen_rope_bridge()
        except ImportError:raise UploadRejected("tokenizer dependencies unavailable; no encoding executed",503) from None
        torch.set_num_threads(2)
        self.tokenizer=Qwen3TTSTokenizer.from_pretrained(str(self.directory),device_map='cpu',dtype=torch.float32,
                          attn_implementation='eager',local_files_only=True,trust_remote_code=False,use_safetensors=True)
        cfg=self.tokenizer.config
        if (cfg.model_type!='qwen3_tts_tokenizer_12hz' or cfg.input_sample_rate!=SR or cfg.output_sample_rate!=SR
            or cfg.encode_downsample_rate!=1920 or cfg.decode_upsample_rate!=1920 or cfg.encoder_valid_num_quantizers!=16
            or cfg.encoder_config.codebook_size!=2048 or cfg.decoder_config.codebook_size!=2048 or cfg.decoder_config.num_quantizers!=16
            or self.tokenizer.feature_extractor.sampling_rate!=SR
            or str(self.tokenizer.device)!='cpu' or self.tokenizer.model.dtype!=torch.float32):
            raise UploadRejected("loaded tokenizer contract mismatch",409)
        self.tokenizer.model.eval()
        self.version=importlib.metadata.version('qwen-tts')
        self.finish()

    def __call__(self,waveform):
        result=self.tokenizer.encode(waveform,sr=SR)
        if not isinstance(result.audio_codes,(list,tuple)) or len(result.audio_codes)!=1:
            raise UploadRejected("tokenizer must return exactly one sample",409)
        return result.audio_codes[0].cpu().tolist()

    def finish(self):
        if model_fingerprint(self.directory)!=self.expected_hash:raise UploadRejected("tokenizer model changed during encoding",409)


def validate_codes(codes,frames):
    expected=math.ceil(frames/1920)
    if not isinstance(codes,list) or len(codes)!=expected:raise UploadRejected("acoustic code frame count mismatch",409)
    for row in codes:
        if not isinstance(row,list) or len(row)!=16 or any(type(x) is not int or not 0<=x<2048 for x in row):
            raise UploadRejected("expected 16 integer codebooks in range 0..2047",409)
    return codes


class TrainingCodesStore(TrainingDataStore):
    @classmethod
    def configured(cls,state,limits):
        return cls(Path(state)/'training_codes',limits,
                   maximum=positive_env('QTTS_MAX_CODE_DATASETS',32,128),
                   per_bytes=positive_env('QTTS_MAX_CODE_DATASET_BYTES',64<<20,256<<20),
                   total_bytes=positive_env('QTTS_MAX_ALL_CODE_DATA_BYTES',256<<20,4<<30))

    def _size(self,directory):
        self.fs._directory(directory)
        total=0
        for entry in directory.iterdir():
            info=entry.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.getuid():total+=info.st_size
            elif stat.S_ISDIR(info.st_mode) and entry.name in ('audio','source'):
                for child in self.fs._directory(entry).iterdir():
                    info=child.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid():
                        raise UploadRejected('unsafe codes snapshot file',409)
                    total+=info.st_size
            else:raise UploadRejected('unsafe codes snapshot directory',409)
        return total

    def _manifest(self,directory,did,pinned=None):
        raw=self._read_bytes(directory/'manifest.json',256<<10)
        if pinned is not None and digest(raw)!=pinned:raise UploadRejected('pinned codes manifest hash changed',409)
        try:
            m=json.loads(raw)
            if set(m)!={'schema','id','kind','state','created','source_id','source_manifest_sha256','upstream_contract_commit','engine','samples','jsonl_sha256','rank_plan_sha256','checks'}:raise ValueError()
            if type(m['schema']) is not int or m['schema'] not in (1,2) or m['id']!=did or m['kind']!='qwen_acoustic_codes':raise ValueError()
            identifier(m['id']);identifier(m['source_id'])
            if m['upstream_contract_commit']!=UPSTREAM or not isinstance(m['created'],str) or len(m['created'])>64:raise ValueError()
            engine=m['engine']
            if set(engine)!={'kind','device','model_tree_sha256','package_version'} or engine['device']!='cpu':raise ValueError()
            real=engine['kind']=='qwen3_tts_tokenizer_12hz'
            if not real and engine['kind']!='test_fixture':raise ValueError()
            if not isinstance(engine['package_version'],str) or len(engine['package_version'])>128:raise ValueError()
            if real:
                if not isinstance(engine['model_tree_sha256'],str) or not DIGEST.fullmatch(engine['model_tree_sha256']):raise ValueError()
            elif engine['model_tree_sha256'] is not None:raise ValueError()
            if m['state']!=('audio_codes_prepared' if real else 'test_only_codes'):raise ValueError()
            if m['checks']!=self._checks(real):raise ValueError()
            for key in ('source_manifest_sha256','jsonl_sha256','rank_plan_sha256'):
                if not isinstance(m[key],str) or not DIGEST.fullmatch(m[key]):raise ValueError()
            samples=m['samples'];seen=set();frames=0
            if not isinstance(samples,list) or not 0<len(samples)<=min(16,self.limits.files):raise ValueError()
            for s in samples:
                if set(s)!={'id','frames','audio_sha256','text_sha256','row_sha256'}:raise ValueError()
                identifier(s['id'])
                if s['id'] in seen or type(s['frames']) is not int or not 36000<=s['frames']<=SR*min(240,self.limits.seconds):raise ValueError()
                seen.add(s['id']);frames+=s['frames']
                for key in ('audio_sha256','text_sha256','row_sha256'):
                    if not isinstance(s[key],str) or not DIGEST.fullmatch(s[key]):raise ValueError()
            if frames>SR*min(900,self.limits.total_seconds):raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError):raise UploadRejected('invalid codes manifest',409) from None
        return m,digest(raw)

    @staticmethod
    def _checks(real):
        return {'audio_codes_structurally_verified':True,'tokenization_executed':real,'tokenization_verified':False,
                'training_verified':False,'two_rank_execution_verified':False,'inference_verified':False}

    def _summary(self,m,sha,*,verified=False):
        return {'id':m['id'],'state':m['state'],'source_id':m['source_id'],'sample_count':len(m['samples']),
                'manifest_sha256':sha,'integrity_verified_now':verified,'checks':m['checks'],
                'schema':m['schema'],'source_provenance_policy':'sealed-source-v1' if m['schema']==2 else 'legacy-unsealed',
                'provenance_verified_now':bool(verified and m['schema']==2),'read_lease_supported':True,
                'relative_directory':'training_codes/'+m['id'],'storage':'local-session-only; excluded from Dataset backup'}

    def _verify(self,directory,did,expected_hash=None):
        m,sha=self._manifest(directory,did,expected_hash)
        if self._size(directory)>self.per_bytes:raise UploadRejected('codes snapshot byte budget exceeded',409)
        expected={'manifest.json','train_with_codes.jsonl','rank_plan.json','audio'}
        if m['schema']==2:expected.add('source')
        if {p.name for p in directory.iterdir()}!=expected:raise UploadRejected('unexpected codes files',409)
        audio=self.fs._directory(directory/'audio')
        if {p.name for p in audio.iterdir()}!={s['id']+'.wav' for s in m['samples']}:raise UploadRejected('codes audio membership changed',409)
        raw=self._read_bytes(directory/'train_with_codes.jsonl',4<<20);plan=self._read_bytes(directory/'rank_plan.json',32<<10)
        if digest(raw)!=m['jsonl_sha256'] or digest(plan)!=m['rank_plan_sha256']:raise UploadRejected('codes index hash mismatch',409)
        try:
            rows=[json.loads(line) for line in raw.split(b'\n') if line]
            if len(rows)!=len(m['samples']):raise ValueError()
            reference=None
            for row,sample in zip(rows,m['samples']):
                if set(row)!={'audio','text','ref_audio','audio_codes'} or row['audio']!='audio/'+sample['id']+'.wav':raise ValueError()
                if row['ref_audio'] not in {'audio/'+s['id']+'.wav' for s in m['samples']}:raise ValueError()
                if reference is not None and reference!=row['ref_audio']:raise ValueError()
                reference=row['ref_audio']
                from training_data import transcript
                if transcript(row['text'])!=row['text'] or digest(row['text'].encode())!=sample['text_sha256'] or digest(encode(row))!=sample['row_sha256']:raise ValueError()
                validate_codes(row['audio_codes'],sample['frames'])
                wav=self._read_bytes(audio/(sample['id']+'.wav'),min(self.limits.file_bytes,self.per_bytes))
                if len(wav)!=44+sample['frames']*2 or digest(wav)!=sample['audio_sha256']:raise ValueError()
            if sum(len(r['text']) for r in rows)>16000 or json.loads(plan)!=rank_plan([s['id'] for s in m['samples']]):raise ValueError()
        except (ValueError,TypeError,KeyError,UnicodeError):raise UploadRejected('codes content invalid or changed',409) from None
        if m['schema']==2:self._verify_provenance(directory,m,rows,plan)
        return self._summary(m,sha,verified=True)

    def _verify_provenance(self,directory,m,rows,plan):
        source=self.fs._directory(directory/'source')
        if {p.name for p in source.iterdir()}!={'manifest.json','train_raw.jsonl'}:raise UploadRejected('sealed source membership changed',409)
        origin,hashed=TrainingDataStore._meta(self,source,m['source_id'])
        original=self._read_bytes(source/'train_raw.jsonl',128<<10)
        if hashed!=m['source_manifest_sha256'] or digest(original)!=origin['jsonl_sha256'] or digest(plan)!=origin['rank_plan_sha256']:
            raise UploadRejected('sealed source hash mismatch',409)
        try:
            inputs=[json.loads(line) for line in original.split(b'\n') if line]
            if len(inputs)!=len(rows) or len(origin['samples'])!=len(m['samples']):raise ValueError()
            for row,raw,sample,source_sample in zip(rows,inputs,m['samples'],origin['samples']):
                if set(raw)!={'audio','text','ref_audio'} or {k:v for k,v in row.items() if k!='audio_codes'}!=raw:raise ValueError()
                if raw['ref_audio']!='audio/'+origin['reference_sample_id']+'.wav':raise ValueError()
                for key in ('id','frames','audio_sha256','text_sha256'):
                    if sample[key]!=source_sample[key]:raise ValueError()
        except (ValueError,TypeError,KeyError,UnicodeError):raise UploadRejected('sealed source does not match acoustic codes',409) from None

    def prepare(self,inputs,did,pinned,encoder_factory,*,cancelled=lambda:False):
        with inputs.lease(did,pinned) as (source,meta,rows),self.fs._global():
            self._sweep();directories=self.fs._directories()
            if len(directories)>=self.maximum:raise UploadRejected('codes snapshot count budget reached',409)
            reserve=inputs._size(source)+(8<<20)
            if sum(self._size(d) for d in directories)+reserve>self.total_bytes:raise UploadRejected('total codes byte budget reached',413)
            if shutil.disk_usage(self.root).free<self.free_bytes+reserve:raise UploadRejected('insufficient disk for acoustic codes',507)
            if cancelled():raise UploadRejected('encoding cancelled',409)
            encoder=encoder_factory()  # Under the source lease, never before verification.
            real=isinstance(encoder,QwenCPUEncoder)
            engine={'kind':'qwen3_tts_tokenizer_12hz' if real else 'test_fixture','device':'cpu',
                    'model_tree_sha256':encoder.expected_hash if real else None,'package_version':encoder.version if real else 'test-only'}
            cid=uuid.uuid4().hex;staging=self.root/('.pending-'+cid);destination=self.root/cid
            if destination.exists():raise UploadRejected('codes id collision; retry',409)
            staging.mkdir(mode=0o700)
            try:
                (staging/'audio').mkdir(mode=0o700);(staging/'source').mkdir(mode=0o700)
                source_manifest=inputs._read_bytes(source/'manifest.json',128<<10)
                source_jsonl=inputs._read_bytes(source/'train_raw.jsonl',128<<10)
                if digest(source_manifest)!=pinned or digest(source_jsonl)!=meta['jsonl_sha256']:raise UploadRejected('source changed before sealing',409)
                self._write(staging/'source'/'manifest.json',source_manifest)
                self._write(staging/'source'/'train_raw.jsonl',source_jsonl)
                output=[];samples=[]
                for row,sample in zip(rows,meta['samples']):
                    if cancelled():raise UploadRejected('encoding cancelled',409)
                    wav=inputs._read_bytes(source/row['audio'],min(inputs.limits.file_bytes,inputs.per_bytes))
                    canonical,info=canonical_wav(wav,min(240,self.limits.seconds),SR*min(900,self.limits.total_seconds))
                    if canonical!=wav or info['frames']!=sample['frames'] or digest(wav)!=sample['audio_sha256']:raise UploadRejected('leased audio changed',409)
                    waveform=np.frombuffer(wav,offset=44,dtype='<i2').astype(np.float32)/32768
                    codes=validate_codes(encoder(waveform),sample['frames'])
                    if cancelled():raise UploadRejected('encoding cancelled',409)
                    out={**row,'audio_codes':codes};output.append(encode(out))
                    if sum(map(len,output))>4<<20:raise UploadRejected('codes JSONL budget reached',413)
                    self._write(staging/'audio'/(sample['id']+'.wav'),wav)
                    samples.append({'id':sample['id'],'frames':sample['frames'],'audio_sha256':sample['audio_sha256'],'text_sha256':sample['text_sha256'],'row_sha256':digest(encode(out))})
                    if self._size(staging)+sum(map(len,output))+(256<<10)>self.per_bytes:raise UploadRejected('codes snapshot byte budget reached',413)
                if len(samples)!=len(meta['samples']) or len(rows)!=len(samples):raise UploadRejected('incomplete sample coverage',409)
                if real:encoder.finish()
                inputs.verify(did,pinned)
                plan=inputs._read_bytes(source/'rank_plan.json',32<<10);jsonl=b''.join(output)
                self._write(staging/'train_with_codes.jsonl',jsonl);self._write(staging/'rank_plan.json',plan)
                manifest={'schema':2,'id':cid,'kind':'qwen_acoustic_codes','state':'audio_codes_prepared' if real else 'test_only_codes',
                          'created':timestamp(),'source_id':did,'source_manifest_sha256':pinned,'upstream_contract_commit':UPSTREAM,
                          'engine':engine,'samples':samples,'jsonl_sha256':digest(jsonl),'rank_plan_sha256':digest(plan),'checks':self._checks(real)}
                self._write(staging/'manifest.json',encode(manifest))
                result=self._verify(staging,cid)
                if cancelled():raise UploadRejected('encoding cancelled',409)
                os.rename(staging,destination)
                return result
            except BaseException:
                shutil.rmtree(staging);raise

    def list(self):
        with self.fs._global():return [self._summary(*self._manifest(d,d.name)) for d in self.fs._directories()]

    @contextmanager
    def lease_with_fd(self,did,expected_hash):
        """Pinned inspection/future-reader lease, NOT permission to train.

        Fixture and legacy states remain unchanged. Future trainers must apply
        their own real encoding/provenance/semantic/hardware admission gates.
        """
        identifier(did)
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):
            raise UploadRejected('a pinned codes manifest SHA256 is required',400)
        stream=None
        try:
            with self.fs._global():
                directory=self.fs._path(did)
                stream=self.fs._acquire(self.root/('.use-'+did))
                self._verify(directory,did,expected_hash)
                meta,_=self._manifest(directory,did,expected_hash)
                raw=self._read_bytes(directory/'train_with_codes.jsonl',4<<20)
                rows=[json.loads(line) for line in raw.split(b'\n') if line]
            yield directory,meta,rows,stream.fileno()
        finally:
            if stream is not None:stream.close()

    @contextmanager
    def lease(self,did,expected_hash):
        with self.lease_with_fd(did,expected_hash) as (directory,meta,rows,_):
            yield directory,meta,rows

    @contextmanager
    def adopt_lease(self,did,expected_hash,fd):
        """Adopt only an already-held same-OFD lease, for controlled rank children.

        No global lock: parent protects this version and multiple ranks must
        validate concurrently. This is NOT an admission/authorization bypass.
        """
        identifier(did)
        if type(fd) is not int or fd<3:raise UploadRejected('invalid codes lease descriptor',409)
        owned=None
        try:
            with self.fs._open(self.root/('.use-'+did)) as probe:
                owned=os.dup(fd)
                a,b=os.fstat(owned),os.fstat(probe.fileno())
                if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise UploadRejected('codes lease inode mismatch',409)
                try:fcntl.flock(probe.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:pass
                else:raise UploadRejected('codes lease is not held',409)
                try:fcntl.flock(owned,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:raise UploadRejected('descriptor does not own codes lease',409) from None
            directory=self.fs._path(did)
            self._verify(directory,did,expected_hash)
            meta,_=self._manifest(directory,did,expected_hash)
            rows=[json.loads(line) for line in self._read_bytes(directory/'train_with_codes.jsonl',4<<20).split(b'\n') if line]
            yield directory,meta,rows
        finally:
            if owned is not None:os.close(owned)

    def delete(self,did,expected_hash):
        identifier(did)
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):raise UploadRejected('pinned codes manifest hash required',400)
        with self.fs._global():
            directory=self.fs._path(did);self._manifest(directory,did,expected_hash)
            with self.fs._acquire(self.root/('.use-'+did)):
                shutil.rmtree(directory)
                (self.root/('.use-'+did)).unlink()
            return {'deleted':did,'source_deleted':False,'profiles_deleted':False}
