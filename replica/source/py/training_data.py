"""Private immutable raw SFT inputs; NO tokenizer, optimizer or GPU execution.

Initial format gate intentionally accepts only complete mono 24kHz PCM16 WAV.
Relative JSONL paths are resolved from the dataset directory, not the JSONL path.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import stat
import struct
import uuid
import wave

import numpy as np
from resource_limits import UploadRejected, positive_env
from voice_library import LibraryStore, identifier, timestamp, DIGEST

SR=24000
UPSTREAM="022e286b98fbec7e1e916cb940cdf532cd9f488e"
CHECKS={"audio_format_verified":True,"assignment_plan_verified":True,
        "transcript_verified":False,"speaker_identity_verified":False,"tokenization_verified":False,
        "training_verified":False,"two_rank_execution_verified":False,"inference_verified":False}


def digest(data):return hashlib.sha256(data).hexdigest()

def encode(value):return (json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")


def transcript(value):
    if not isinstance(value,str):raise UploadRejected("each selected sample requires its own transcript",400)
    value=value.strip()
    if not 0<len(value)<=2000 or any(ord(c)<32 and c not in "\n\t" or ord(c)==127 or 0xD800<=ord(c)<=0xDFFF for c in value):
        raise UploadRejected("transcript must contain 1..2000 valid Unicode characters",400)
    return value


def rank_plan(ids,seed=1729,epoch=0):
    """Mathematical assignment only, NOT a DistributedSampler execution trace."""
    if not ids or len(set(ids))!=len(ids):raise ValueError("nonempty unique ids required")
    if type(seed) is not int or not 0<=seed<2**32 or type(epoch) is not int or not 0<=epoch<2**31:raise ValueError("invalid seed or epoch")
    order=sorted(ids,key=lambda sid:hashlib.sha256((str(seed)+":"+sid).encode("ascii")).digest())
    offset=epoch%len(order);order=order[offset:]+order[:offset]
    ranks=[[],[]]
    for index in range(math.ceil(len(order)/2)*2):
        ranks[index%2].append({"sample_id":order[index%len(order)],"padding":index>=len(order)})
    return {"kind":"assignment_plan_not_execution","world_size":2,"seed":seed,"epoch":epoch,
            "drop_last":False,"ranks":ranks,"training_verified":False}


def canonical_wav(raw,seconds,total_remaining):
    # Audit RIFF boundaries before wave.readframes; no truncated/ambiguous data.
    if len(raw)<44 or raw[:4]!=b"RIFF" or raw[8:12]!=b"WAVE" or struct.unpack_from("<I",raw,4)[0]!=len(raw)-8:
        raise UploadRejected("training inputs require complete 24kHz mono PCM16 RIFF/WAV; no automatic conversion",400)
    offset=12;chunks={}
    while offset<len(raw):
        if offset+8>len(raw):raise UploadRejected("malformed WAV chunk",400)
        tag=raw[offset:offset+4];size=struct.unpack_from("<I",raw,offset+4)[0]
        end=offset+8+size
        if end+(size%2)>len(raw):raise UploadRejected("truncated WAV chunk",400)
        if tag in (b"fmt ",b"data"):
            if tag in chunks:raise UploadRejected("ambiguous duplicate WAV format/data chunk",400)
            chunks[tag]=raw[offset+8:end]
        offset=end+(size%2)
    fmt=chunks.get(b"fmt ",b"");pcm=chunks.get(b"data",b"")
    if len(fmt)!=16 or struct.unpack("<HHIIHH",fmt)!=(1,1,SR,SR*2,2,16) or not pcm or len(pcm)%2:
        raise UploadRejected("only mono 24kHz PCM16 WAV is accepted for training inputs",400)
    frames=len(pcm)//2
    if frames<SR*1.5 or frames>SR*seconds or frames>total_remaining:
        raise UploadRejected("training audio duration exceeds per-file/total limits or is shorter than 1.5s",413)
    values=np.frombuffer(pcm,dtype="<i2");low,high=int(values.min()),int(values.max())
    if low==high:raise UploadRejected("empty/silent/constant audio cannot form a training input",400)
    power=0.0
    for start in range(0,len(values),65536):
        block=values[start:start+65536].astype(np.float64);power+=float(np.dot(block,block))
    output=io.BytesIO()
    with wave.open(output,"wb") as stream:
        stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(SR);stream.writeframes(pcm)
    return output.getvalue(),{"frames":frames,"seconds":round(frames/SR,6),"sample_rate":SR,"channels":1,"sample_width":2,
                             "peak":max(abs(low),abs(high))/32768,"rms":math.sqrt(power/frames)/32768}


class TrainingDataStore:
    def __init__(self,root,limits,*,maximum=32,per_bytes=64<<20,total_bytes=256<<20,free_bytes=256<<20):
        # Reuse the already-reviewed private path/regular-file/nonblocking lock
        # primitives, never the raw-library metadata or create/build operations.
        self.fs=LibraryStore(root,maximum=maximum)
        self.root=self.fs.root;self.limits=limits;self.maximum=maximum
        self.per_bytes=per_bytes;self.total_bytes=total_bytes;self.free_bytes=free_bytes

    @classmethod
    def configured(cls,state,limits):
        return cls(Path(state)/"training_data",limits,
                   maximum=positive_env("QTTS_MAX_TRAINING_DATASETS",32,128),
                   per_bytes=positive_env("QTTS_MAX_TRAINING_DATASET_BYTES",64<<20,256<<20),
                   total_bytes=positive_env("QTTS_MAX_ALL_TRAINING_DATA_BYTES",256<<20,4<<30))

    def _write(self,path,data):
        with self.fs._open(path,create=True,exclusive=True) as stream:
            stream.write(data);stream.flush();os.fsync(stream.fileno())

    def _read_bytes(self,path,maximum):
        with self.fs._open(path) as stream:
            if os.fstat(stream.fileno()).st_size>maximum:raise UploadRejected("training input file budget exceeded",409)
            data=stream.read(maximum+1)
        if len(data)>maximum:raise UploadRejected("training input file budget exceeded",409)
        return data

    def _size(self,directory):
        self.fs._directory(directory)
        total=0
        for entry in directory.iterdir():
            info=entry.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_nlink==1:total+=info.st_size
            elif stat.S_ISDIR(info.st_mode) and entry.name=="audio":
                for audio in self.fs._directory(entry).iterdir():
                    info=audio.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise UploadRejected("unsafe training input file",409)
                    total+=info.st_size
            else:raise UploadRejected("unsafe training input directory",409)
        return total

    def _sweep(self):
        # Held global lock: no live publisher can own these staging directories.
        for path in self.root.iterdir():
            if path.name.startswith(".pending-"):
                if path.is_symlink() or path.is_file():path.unlink()
                elif path.is_dir():shutil.rmtree(path)

    def _meta(self,directory,expected_id):
        raw=self._read_bytes(directory/"manifest.json",128<<10)
        try:
            meta=json.loads(raw)
            if set(meta)!={"schema","kind","state","id","created","library_id","library_name","source_revision","reference_sample_id","declarations","checks","upstream_commit","samples","jsonl_sha256","rank_plan_sha256"}:raise ValueError()
            if type(meta["schema"]) is not int or meta["schema"]!=1 or meta["id"]!=expected_id or meta["kind"]!="qwen_raw_sft_input" or meta["state"]!="input_snapshot_ready":raise ValueError()
            identifier(meta["id"]);identifier(meta["library_id"])
            if type(meta["source_revision"]) is not int or meta["source_revision"]<1:raise ValueError()
            if meta["checks"]!=CHECKS or meta["declarations"]!={"voice_rights_confirmed":True,"single_speaker_confirmed":True}:raise ValueError()
            if not isinstance(meta["library_name"],str) or len(meta["library_name"])>64 or not isinstance(meta["created"],str) or len(meta["created"])>64:raise ValueError()
            samples=meta["samples"]
            if not isinstance(samples,list) or not 0<len(samples)<=min(16,self.limits.files):raise ValueError()
            seen=set();frames=0
            for sample in samples:
                if set(sample)!={"id","source_name","source_sha256","audio_sha256","text_sha256","bytes","frames","seconds","sample_rate","channels","sample_width","peak","rms"}:raise ValueError()
                sid=identifier(sample["id"])
                if sid in seen:raise ValueError()
                seen.add(sid)
                for key in ("source_sha256","audio_sha256","text_sha256"):
                    if not isinstance(sample[key],str) or not DIGEST.fullmatch(sample[key]):raise ValueError()
                if type(sample["frames"]) is not int or not SR*1.5<=sample["frames"]<=SR*min(240,self.limits.seconds):raise ValueError()
                if type(sample["bytes"]) is not int or sample["bytes"]!=44+2*sample["frames"]:raise ValueError()
                if (sample["sample_rate"],sample["channels"],sample["sample_width"])!=(SR,1,2):raise ValueError()
                if sample["seconds"]!=round(sample["frames"]/SR,6):raise ValueError()
                for key in ("peak","rms"):
                    if type(sample[key]) not in (int,float) or not 0<sample[key]<=1:raise ValueError()
                if not isinstance(sample["source_name"],str) or len(sample["source_name"])>128:raise ValueError()
                frames+=sample["frames"]
            if frames>SR*min(900,self.limits.total_seconds) or meta["reference_sample_id"] not in seen:raise ValueError()
            if next(s["frames"] for s in samples if s["id"]==meta["reference_sample_id"])>16*SR:raise ValueError()
            for key in ("jsonl_sha256","rank_plan_sha256"):
                if not isinstance(meta[key],str) or not DIGEST.fullmatch(meta[key]):raise ValueError()
            if meta["upstream_commit"]!=UPSTREAM:raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError,StopIteration):
            raise UploadRejected("training input manifest is invalid",409) from None
        return meta,digest(raw)

    def _summary(self,meta,manifest_hash,*,verified=False):
        return {"id":meta["id"],"state":meta["state"],"created":meta["created"],"library_id":meta["library_id"],"library_name":meta["library_name"],
                "source_revision":meta["source_revision"],"sample_count":len(meta["samples"]),"seconds":round(sum(s["frames"] for s in meta["samples"])/SR,6),
                "manifest_sha256":manifest_hash,"relative_directory":"training_data/"+meta["id"],
                "integrity_verified_now":verified,"checks":dict(CHECKS),"storage":"local-session-only; excluded from Dataset backup"}

    def _verify(self,directory,did,expected_hash=None):
        meta,hashed=self._meta(directory,did)
        if expected_hash is not None and expected_hash!=hashed:raise UploadRejected("pinned training manifest hash changed",409)
        if self._size(directory)>self.per_bytes:raise UploadRejected("training snapshot byte budget exceeded",409)
        expected_files={"manifest.json","train_raw.jsonl","rank_plan.json","audio"}
        if {p.name for p in directory.iterdir()}!=expected_files:raise UploadRejected("unexpected files in training snapshot",409)
        audio_dir=self.fs._directory(directory/"audio")
        if {p.name for p in audio_dir.iterdir()}!={s["id"]+".wav" for s in meta["samples"]}:raise UploadRejected("training audio membership changed",409)
        jsonl=self._read_bytes(directory/"train_raw.jsonl",128<<10);plan_raw=self._read_bytes(directory/"rank_plan.json",32<<10)
        if digest(jsonl)!=meta["jsonl_sha256"] or digest(plan_raw)!=meta["rank_plan_sha256"]:raise UploadRejected("training index integrity check failed",409)
        try:
            rows=[json.loads(line) for line in jsonl.split(b"\n") if line]
            if len(rows)!=len(meta["samples"]):raise ValueError()
            for row,sample in zip(rows,meta["samples"]):
                if set(row)!={"audio","text","ref_audio"} or row["audio"]!="audio/"+sample["id"]+".wav" or row["ref_audio"]!="audio/"+meta["reference_sample_id"]+".wav":raise ValueError()
                if transcript(row["text"])!=row["text"] or digest(row["text"].encode("utf-8"))!=sample["text_sha256"]:raise ValueError()
                audio=self._read_bytes(audio_dir/(sample["id"]+".wav"),min(self.limits.file_bytes,self.per_bytes))
                if len(audio)!=sample["bytes"] or digest(audio)!=sample["audio_sha256"]:raise ValueError()
            if sum(len(row["text"]) for row in rows)>16000 or json.loads(plan_raw)!=rank_plan([s["id"] for s in meta["samples"]]):raise ValueError()
        except (ValueError,TypeError,KeyError,UnicodeError):raise UploadRejected("training snapshot content is invalid or changed",409) from None
        return self._summary(meta,hashed,verified=True)

    def prepare(self,libraries,body):
        if body.get("voice_rights_confirmed") is not True or body.get("single_speaker_confirmed") is not True:
            raise UploadRejected("explicit voice-rights and single-speaker declarations required",400)
        rows=body.get("samples")
        if not isinstance(rows,list) or not 0<len(rows)<=min(16,self.limits.files):raise UploadRejected("select bounded training samples with transcripts",400)
        selected=[];texts={}
        for row in rows:
            if not isinstance(row,dict) or set(row)!={"id","text"}:raise UploadRejected("each sample requires exactly id and text",400)
            sid=identifier(row["id"])
            if sid in texts:raise UploadRejected("duplicate training sample",400)
            selected.append(sid);texts[sid]=transcript(row["text"])
        if sum(map(len,texts.values()))>16000:raise UploadRejected("total transcript budget exceeded",413)
        reference=identifier(body.get("reference_sample_id"))
        if reference not in texts:raise UploadRejected("reference must belong to selected samples",400)
        with self.fs._global():
            self._sweep();directories=self.fs._directories()
            if len(directories)>=self.maximum:raise UploadRejected("training input snapshot count budget reached",409)
            with libraries.snapshot(body.get("library_id"),body.get("revision"),selected) as lease:
                reserve=sum(len(data) for _,data in lease.files)+(128<<10)
                if sum(self._size(d) for d in directories)+reserve>self.total_bytes:raise UploadRejected("total training snapshot byte budget reached",413)
                if shutil.disk_usage(self.root).free<self.free_bytes+reserve:raise UploadRejected("insufficient disk for training inputs",507)
                did=uuid.uuid4().hex;staging=self.root/(".pending-"+did);destination=self.root/did
                if destination.exists():raise UploadRejected("dataset id collision; retry",409)
                staging.mkdir(mode=0o700)
                try:
                    (staging/"audio").mkdir(mode=0o700)
                    samples=[];raw_rows=[];used_frames=0;written=0
                    original={s["id"]:s for s in lease.metadata["samples"]}
                    for sid,(_,raw) in zip(selected,lease.files):
                        wav,info=canonical_wav(raw,min(240,self.limits.seconds),SR*min(900,self.limits.total_seconds)-used_frames)
                        if sid==reference and info["frames"]>16*SR:raise UploadRejected("reference must be at most 16 seconds; no automatic truncation",413)
                        if len(wav)>self.limits.file_bytes:raise UploadRejected("canonical WAV file byte budget exceeded",413)
                        used_frames+=info["frames"];written+=len(wav)
                        if written>self.per_bytes:raise UploadRejected("training snapshot byte budget reached",413)
                        self._write(staging/"audio"/(sid+".wav"),wav)
                        samples.append({"id":sid,"source_name":original[sid]["name"],"source_sha256":original[sid]["sha256"],"audio_sha256":digest(wav),"text_sha256":digest(texts[sid].encode("utf-8")),"bytes":len(wav),**info})
                        raw_rows.append({"audio":"audio/"+sid+".wav","text":texts[sid],"ref_audio":"audio/"+reference+".wav"})
                    jsonl=b"".join(encode(row) for row in raw_rows);plan=encode(rank_plan(selected))
                    self._write(staging/"train_raw.jsonl",jsonl);self._write(staging/"rank_plan.json",plan)
                    meta={"schema":1,"kind":"qwen_raw_sft_input","state":"input_snapshot_ready","id":did,"created":timestamp(),"library_id":lease.metadata["id"],"library_name":lease.metadata["name"],"source_revision":lease.metadata["revision"],"reference_sample_id":reference,
                          "declarations":{"voice_rights_confirmed":True,"single_speaker_confirmed":True},"checks":dict(CHECKS),"upstream_commit":UPSTREAM,"samples":samples,"jsonl_sha256":digest(jsonl),"rank_plan_sha256":digest(plan)}
                    self._write(staging/"manifest.json",encode(meta))
                    result=self._verify(staging,did)
                    os.rename(staging,destination)
                    return result
                except BaseException:
                    shutil.rmtree(staging);raise

    def list(self):
        with self.fs._global():
            return sorted([self._summary(*self._meta(d,d.name)) for d in self.fs._directories()],key=lambda row:row["created"],reverse=True)

    def verify(self,did,expected_hash):
        identifier(did)
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):raise UploadRejected("a pinned manifest SHA256 is required",400)
        with self.fs._global():return self._verify(self.fs._path(did),did,expected_hash)

    @contextmanager
    def lease(self,did,expected_hash):
        """Verified read lease; no long global lock, cooperative delete excluded."""
        identifier(did)
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):
            raise UploadRejected("a pinned manifest SHA256 is required",400)
        stream=None
        try:
            with self.fs._global():
                directory=self.fs._path(did)
                stream=self.fs._acquire(self.root/(".use-"+did))
                self._verify(directory,did,expected_hash)
                meta,_=self._meta(directory,did)
                rows=[json.loads(line) for line in self._read_bytes(directory/"train_raw.jsonl",128<<10).split(b"\n") if line]
            yield directory,meta,rows
        finally:
            if stream is not None:stream.close()

    def delete(self,did,expected_hash):
        identifier(did)
        if not isinstance(expected_hash,str) or not DIGEST.fullmatch(expected_hash):raise UploadRejected("a pinned manifest SHA256 is required",400)
        with self.fs._global():
            directory=self.fs._path(did);meta,hashed=self._meta(directory,did)
            if hashed!=expected_hash:raise UploadRejected("manifest changed; refresh before deletion",409)
            with self.fs._acquire(self.root/(".use-"+did)):
                shutil.rmtree(directory)
                (self.root/(".use-"+did)).unlink()
            return {"deleted":did,"source_library_deleted":False,"profiles_deleted":False}
