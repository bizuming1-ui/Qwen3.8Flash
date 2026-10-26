"""Local raw reference libraries, NOT model training or inference-ready profiles.

Linux flock leases span background builds. Metadata commits are atomic; orphan
sample files are reclaimed by the next mutation. No raw audio download endpoint.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import unicodedata
import uuid

from resource_limits import UploadRejected, positive_env

ID = re.compile(r"[0-9a-f]{32}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise UploadRejected("invalid library or sample id", 400)
    return value


def text(value, maximum, field):
    if not isinstance(value, str):
        raise UploadRejected(field + " must be text", 400)
    value = unicodedata.normalize("NFC", value.strip())
    if not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise UploadRejected(field + " is empty, too long or contains invalid/control characters", 400)
    return value


def atomic_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".pending-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)


class LibraryBusy(UploadRejected):
    pass


@dataclass
class BuildLease:
    directory: Path
    file: object
    metadata: dict
    files: list

    def close(self):
        if self.file is not None:
            self.file.close(); self.file = None
        self.files.clear()


class LibraryStore:
    def __init__(self, root, *, maximum=128, files=16, file_bytes=20 << 20,
                 library_bytes=64 << 20, total_bytes=512 << 20, free_bytes=256 << 20):
        self.root = Path(root)
        self.maximum, self.files, self.file_bytes = maximum, files, file_bytes
        self.library_bytes, self.total_bytes, self.free_bytes = library_bytes, total_bytes, free_bytes
        self._directory(self.root, create=True)

    @classmethod
    def configured(cls, state, limits):
        return cls(Path(state) / "libraries", maximum=positive_env("QTTS_MAX_LIBRARIES",128,1024),
                   files=limits.files, file_bytes=limits.file_bytes,
                   library_bytes=positive_env("QTTS_MAX_LIBRARY_BYTES",64<<20,512<<20),
                   total_bytes=positive_env("QTTS_MAX_ALL_LIBRARY_BYTES",512<<20,4<<30))

    def _directory(self, path, create=False):
        if create: path.mkdir(mode=0o700, parents=True, exist_ok=True)
        try: info = path.lstat()
        except FileNotFoundError: raise UploadRejected("no such library",404)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise UploadRejected("unsafe library directory",409)
        os.chmod(path,0o700)
        return path

    def _path(self, lid):
        return self._directory(self.root / identifier(lid))

    def _open(self, path, *, create=False, exclusive=False):
        flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
        descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_EXCL if exclusive else 0),0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise UploadRejected("unsafe library file",409)
            return os.fdopen(descriptor,"r+b" if create else "rb")
        except BaseException:
            os.close(descriptor); raise

    def _acquire(self, path):
        stream = self._open(path,create=True)
        try: fcntl.flock(stream.fileno(),fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            stream.close(); raise LibraryBusy("library storage is busy; retry after current operation",409)
        return stream

    @contextmanager
    def _global(self):
        with self._acquire(self.root / ".lock"): yield

    @contextmanager
    def _edit(self, lid):
        with self._global():
            directory = self._path(lid)
            with self._acquire(directory / ".lease"):
                metadata = self._read(directory)
                self._sweep(directory,metadata)
                yield directory,metadata

    def _directories(self):
        result = [self._path(p.name) for p in self.root.iterdir() if ID.fullmatch(p.name)]
        if len(result)>self.maximum: raise UploadRejected("library count exceeds configured budget",409)
        return result

    def _read(self, directory):
        try:
            with self._open(directory / "library.json") as stream:
                raw = stream.read((256<<10)+1)
            if len(raw)>256<<10: raise ValueError()
            meta = json.loads(raw)
            if (meta.get("schema")!=1 or meta.get("id")!=directory.name or type(meta.get("revision")) is not int
                    or meta["revision"]<1 or not isinstance(meta.get("samples"),list)
                    or len(meta["samples"])>self.files): raise ValueError()
            text(meta["name"],64,"name"); text(meta["language"],32,"language")
            seen=set();total=0
            for sample in meta["samples"]:
                sid=identifier(sample["id"])
                if sid in seen or type(sample["bytes"]) is not int or not 0<sample["bytes"]<=self.file_bytes:raise ValueError()
                if not isinstance(sample["sha256"],str) or not DIGEST.fullmatch(sample["sha256"]):raise ValueError()
                text(sample["name"],128,"filename")
                seen.add(sid);total+=sample["bytes"]
            if total>self.library_bytes:raise ValueError()
            if set(meta)!={"schema","id","name","language","revision","samples","created","updated","last_build","prepared_profile"}:raise ValueError()
            for key in ("created","updated"):text(meta[key],64,key)
            prepared=meta["prepared_profile"]
            if prepared is not None and (not isinstance(prepared,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",prepared)):raise ValueError()
            for sample in meta["samples"]:
                if set(sample)!={"id","name","bytes","sha256","created"}:raise ValueError()
                text(sample["created"],64,"created")
            last=meta["last_build"]
            if last is not None:
                if not isinstance(last,dict) or set(last)!={"job","state","source_revision","sample_ids","profile"}:raise ValueError()
                if not isinstance(last["job"],str) or not re.fullmatch(r"[0-9a-f]{12}",last["job"]):raise ValueError()
                if last["state"] not in ("running","reference_prepared","processing_failed"):raise ValueError()
                if type(last["source_revision"]) is not int or not 1<=last["source_revision"]<=meta["revision"]:raise ValueError()
                if not isinstance(last["sample_ids"],list) or not 0<len(last["sample_ids"])<=self.files:raise ValueError()
                for sid in last["sample_ids"]:identifier(sid)
                if last["profile"] is not None and (not isinstance(last["profile"],str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",last["profile"])):raise ValueError()
            return meta
        except (OSError,ValueError,TypeError,KeyError,AttributeError):
            raise UploadRejected("library metadata is unavailable or invalid",409) from None

    def _sweep(self, directory, meta):
        retained={s["id"]+".audio" for s in meta["samples"]}
        for path in directory.iterdir():
            if path.name.startswith(".pending-") or path.suffix==".audio" and path.name not in retained:
                if path.is_symlink() or path.is_file():path.unlink()

    def _public(self, meta, directory):
        last=meta.get("last_build")
        busy=False
        try: lock=self._acquire(directory / ".lease")
        except LibraryBusy:busy=True
        else:
            # Re-read under the lease so a just-finished job is not incorrectly
            # labelled interrupted from a stale pre-completion metadata read.
            with lock:meta=self._read(directory)
            last=meta.get("last_build")
        state="samples_unverified" if meta["samples"] else "empty"
        if last:
            if last.get("state")=="running":state="processing" if busy else "interrupted"
            elif last.get("source_revision")==meta["revision"]:state=last.get("state","samples_unverified")
        return {"id":meta["id"],"name":meta["name"],"language":meta["language"],"revision":meta["revision"],
                "created":meta["created"],"updated":meta["updated"],"samples":[{k:s[k] for k in ("id","name","bytes","sha256","created")} for s in meta["samples"]],
                "bytes":sum(s["bytes"] for s in meta["samples"]),"state":state,"busy":busy,
                "last_build":last,"prepared_profile":meta.get("prepared_profile"),
                "training_verified":False,"inference_verified":False,"decoded_duration_verified":False}

    def list(self):
        rows=[self._public(self._read(d),d) for d in self._directories()]
        return sorted(rows,key=lambda row:row["created"],reverse=True)

    def get(self, lid):
        directory=self._path(lid)
        return self._public(self._read(directory),directory)

    def create(self, name, language="auto"):
        name=text(name,64,"name");language=text(language,32,"language")
        with self._global():
            directories=self._directories()
            if len(directories)>=self.maximum:raise UploadRejected("library count budget reached",409)
            if any(self._read(d)["name"].casefold()==name.casefold() for d in directories):
                raise UploadRejected("a library with this name already exists",409)
            self._disk(0)
            lid=uuid.uuid4().hex;directory=self.root/lid
            directory.mkdir(mode=0o700)
            meta={"schema":1,"id":lid,"name":name,"language":language,"revision":1,"samples":[],
                  "created":timestamp(),"updated":timestamp(),"last_build":None,"prepared_profile":None}
            try:atomic_json(directory/"library.json",meta)
            except BaseException:shutil.rmtree(directory);raise
        return self.get(lid)

    def _disk(self, incoming):
        if shutil.disk_usage(self.root).free < self.free_bytes+incoming:
            raise UploadRejected("insufficient free disk space for raw references",507)
        used=0
        for directory in self._directories():
            for path in directory.iterdir():
                info=path.lstat()
                if stat.S_ISLNK(info.st_mode):raise UploadRejected("unsafe library file",409)
                if path.suffix==".audio" or path.name.startswith(".pending-"):used+=info.st_size
        if used+incoming>self.total_bytes:raise UploadRejected("total raw reference byte budget reached",413)

    def _revision(self, meta, revision):
        if type(revision) is not int or revision<1:raise UploadRejected("revision must be a positive integer",400)
        if revision!=meta["revision"]:raise UploadRejected("library changed; refresh before editing",409)

    def add(self, lid, revision, files):
        if not files or len(files)>self.files:raise UploadRejected("invalid upload file count",413)
        with self._edit(lid) as (directory,meta):
            self._revision(meta,revision)
            known={s["sha256"] for s in meta["samples"]};added=[]
            for name,data in files:
                if not data or len(data)>self.file_bytes:raise UploadRejected("empty or oversized raw reference",413)
                digest=hashlib.sha256(data).hexdigest()
                if digest in known:continue
                known.add(digest)
                name="".join(c for c in str(name).replace("\\","/").rsplit("/",1)[-1] if c.isprintable())[:128].strip() or "audio"
                added.append(({"id":uuid.uuid4().hex,"name":name,"bytes":len(data),"sha256":digest,"created":timestamp()},data))
            incoming=sum(s["bytes"] for s,_ in added)
            if len(meta["samples"])+len(added)>self.files or sum(s["bytes"] for s in meta["samples"])+incoming>self.library_bytes:
                raise UploadRejected("library sample count or byte budget reached",413)
            self._disk(incoming)
            paths=[]
            try:
                for sample,data in added:
                    path=directory/(sample["id"]+".audio")
                    with self._open(path,create=True,exclusive=True) as stream:
                        paths.append(path)
                        stream.write(data);stream.flush();os.fsync(stream.fileno())
                if added:
                    meta["samples"].extend(s for s,_ in added);meta["revision"]+=1;meta["updated"]=timestamp()
                    atomic_json(directory/"library.json",meta)
            except BaseException:
                for path in paths:path.unlink(missing_ok=True)
                raise
        return self.get(lid)

    def remove_sample(self,lid,sid,revision):
        identifier(sid)
        with self._edit(lid) as (directory,meta):
            self._revision(meta,revision)
            remaining=[s for s in meta["samples"] if s["id"]!=sid]
            if len(remaining)==len(meta["samples"]):raise UploadRejected("no such sample",404)
            meta["samples"]=remaining;meta["revision"]+=1;meta["updated"]=timestamp()
            atomic_json(directory/"library.json",meta)
            self._sweep(directory,meta)
        return self.get(lid)

    def remove(self,lid,revision):
        with self._edit(lid) as (directory,meta):
            self._revision(meta,revision)
            shutil.rmtree(directory)  # never deletes independent prepared profiles
        return {"deleted":lid,"prepared_profiles_deleted":False}

    @contextmanager
    def snapshot(self,lid,revision,sample_ids):
        """Read-only raw snapshot lease; does NOT change reference-job status."""
        if not isinstance(sample_ids,list) or not 0<len(sample_ids)<=self.files:
            raise UploadRejected("select a bounded nonempty sample list",400)
        selected=[identifier(sid) for sid in sample_ids]
        if len(set(selected))!=len(selected):raise UploadRejected("duplicate selected sample",400)
        lease=None;lock=None
        try:
            with self._global():
                directory=self._path(lid);lock=self._acquire(directory/".lease")
                meta=self._read(directory);self._revision(meta,revision)
                by_id={s["id"]:s for s in meta["samples"]};blobs=[]
                for sid in selected:
                    sample=by_id.get(sid)
                    if sample is None:raise UploadRejected("sample does not belong to library",400)
                    with self._open(directory/(sid+".audio")) as stream:
                        if os.fstat(stream.fileno()).st_size!=sample["bytes"]:raise UploadRejected("reference integrity check failed",409)
                        data=stream.read(self.file_bytes+1)
                    if hashlib.sha256(data).hexdigest()!=sample["sha256"]:raise UploadRejected("reference integrity check failed",409)
                    blobs.append((sample["name"],data))
                lease=BuildLease(directory,lock,meta,blobs)
            yield lease
        finally:
            if lease is not None:lease.close()
            elif lock is not None:lock.close()

    def begin(self,lid,revision,sample_ids,job_id):
        if not isinstance(job_id,str) or not re.fullmatch(r"[0-9a-f]{12}",job_id):raise UploadRejected("invalid job id",400)
        if not isinstance(sample_ids,list) or not sample_ids or len(sample_ids)>self.files:
            raise UploadRejected("select at least one bounded reference sample",400)
        selected=[identifier(s) for s in sample_ids]
        if len(selected)!=len(set(selected)):raise UploadRejected("duplicate selected sample id",400)
        with self._global():
            directory=self._path(lid);lock=self._acquire(directory/".lease")
            try:
                meta=self._read(directory);self._revision(meta,revision)
                by_id={s["id"]:s for s in meta["samples"]};blobs=[]
                for sid in selected:
                    sample=by_id.get(sid)
                    if sample is None:raise UploadRejected("selected sample does not belong to this library",400)
                    with self._open(directory/(sid+".audio")) as stream:
                        if os.fstat(stream.fileno()).st_size!=sample["bytes"]:raise UploadRejected("reference integrity check failed",409)
                        data=stream.read(self.file_bytes+1)
                    if hashlib.sha256(data).hexdigest()!=sample["sha256"]:raise UploadRejected("reference integrity check failed",409)
                    blobs.append((sample["name"],data))
                meta["last_build"]={"job":job_id,"state":"running","source_revision":revision,"sample_ids":selected,"profile":None}
                atomic_json(directory/"library.json",meta)
                return BuildLease(directory,lock,meta,blobs)
            except BaseException:lock.close();raise

    def finish(self,lease,job):
        try:
            meta=lease.metadata
            profile=job.get("profile")
            success=job.get("state")=="done" and isinstance(profile,str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}",profile)
            meta["last_build"].update(state="reference_prepared" if success else "processing_failed",profile=profile if success else None)
            if success:meta["prepared_profile"]=profile
            meta["updated"]=timestamp();atomic_json(lease.directory/"library.json",meta)
        finally:lease.close()
