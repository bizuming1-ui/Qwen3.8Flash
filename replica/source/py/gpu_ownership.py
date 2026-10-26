"""Cooperative same-host/same-UID whole GPU fleet lease. NO CUDA measurement.

The fixed namespace intentionally ignores STATE and CUDA_VISIBLE_DEVICES. All
participants must be this version; external processes/UIDs/containers are outside
this protocol. NEVER unlink the lock file or LOCK_UN a shared description.
"""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

from resource_limits import UploadRejected

FD_ENV='QTTS_GPU_LEASE_FD'
NONCE_ENV='QTTS_GPU_LEASE_NONCE'
NONCE=re.compile(r'[0-9a-f]{32}\Z')


def default_root():return Path('/tmp')/('qtts-gpu-ownership-'+str(os.getuid()))


def _root(root,create):
    root=Path(root).absolute()
    for parent in (root,*root.parents):
        if parent.is_symlink():raise UploadRejected('unsafe GPU ownership directory',409)
    if create:root.mkdir(mode=0o700,parents=True,exist_ok=True)
    try:info=root.lstat()
    except FileNotFoundError:return None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid():raise UploadRejected('unsafe GPU ownership directory',409)
    if create:os.chmod(root,0o700)
    elif info.st_mode&0o777!=0o700:raise UploadRejected('GPU ownership directory permissions changed',409)
    return root


def _open(root,create):
    root=_root(root,create)
    if root is None:return None
    try:fd=os.open(root/'fleet.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC|(os.O_CREAT if create else 0),0o600)
    except FileNotFoundError:
        if not create:return None
        raise
    except OSError:raise UploadRejected('unsafe GPU ownership lock',409) from None
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1:
            raise UploadRejected('unsafe GPU ownership lock',409)
        if create:os.fchmod(fd,0o600)
        elif info.st_mode&0o777!=0o600:raise UploadRejected('GPU ownership lock permissions changed',409)
        return fd
    except BaseException:os.close(fd);raise


def _record(fd):
    try:
        raw=os.pread(fd,4097,0)
        if len(raw)>4096:return None
        value=json.loads(raw)
        if set(value)!={'schema','kind','pid','nonce','created'} or type(value['schema']) is not int or value['schema']!=1:return None
        if value['kind'] not in ('inference','offline-reservation') or type(value['pid']) is not int or value['pid']<=0:return None
        if not isinstance(value['nonce'],str) or not NONCE.fullmatch(value['nonce']):return None
        if type(value['created']) not in (float,int) or not 0<value['created']<1e12:return None
        return value
    except (ValueError,TypeError,KeyError,UnicodeError):return None


class GpuLease:
    def __init__(self,fd,root,record):self.fd,self.root,self.record=fd,Path(root),record

    @classmethod
    def acquire(cls,kind,*,root=None):
        if kind not in ('inference','offline-reservation'):raise UploadRejected('invalid GPU lease kind',400)
        root=default_root() if root is None else root
        fd=_open(root,True)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise UploadRejected('GPU fleet ownership is busy; stop managed holders before retry',409) from None
            record={'schema':1,'kind':kind,'pid':os.getpid(),'nonce':uuid.uuid4().hex,'created':time.time()}
            raw=json.dumps(record,allow_nan=False,separators=(',',':')).encode()+b'\n'
            os.ftruncate(fd,0)
            if os.pwrite(fd,raw,0)!=len(raw):raise OSError('short GPU lease record write')
            os.fsync(fd)
            return cls(fd,root,record)
        except BaseException:os.close(fd);raise

    @classmethod
    def adopt(cls,fd,nonce,*,root=None,expected_kind="inference"):
        if expected_kind not in ('inference','offline-reservation'):raise UploadRejected('invalid inherited GPU mode',409)
        if type(fd) is not int or not 3<=fd<1<<20 or not isinstance(nonce,str) or not NONCE.fullmatch(nonce):
            raise UploadRejected('invalid inherited GPU lease',409)
        root=default_root() if root is None else root
        probe=_open(root,False);duplicate=None
        try:
            if probe is None:raise UploadRejected('inherited GPU lease has no lock',409)
            try:duplicate=os.dup(fd)
            except OSError:raise UploadRejected('inherited GPU descriptor unavailable',409) from None
            a,b=os.fstat(duplicate),os.fstat(probe)
            if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise UploadRejected('inherited GPU inode mismatch',409)
            # A freshly opened/unlocked FD must not adopt an old record.
            try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:pass
            else:raise UploadRejected('inherited GPU lease is no longer held',409)
            try:fcntl.flock(duplicate,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise UploadRejected('inherited descriptor does not own the GPU lease',409) from None
            record=_record(duplicate)
            if record is None or record['kind']!=expected_kind or record['nonce']!=nonce:
                raise UploadRejected('inherited GPU mode or nonce mismatch',409)
            result=cls(duplicate,root,record);duplicate=None;return result
        finally:
            if duplicate is not None:os.close(duplicate)
            if probe is not None:os.close(probe)

    def export(self):
        if self.fd is None:raise UploadRejected('GPU lease already closed',409)
        return {FD_ENV:str(self.fd),NONCE_ENV:self.record['nonce']}

    def close(self):
        # Do not flock(LOCK_UN): children share the open file description.
        if self.fd is not None:os.close(self.fd);self.fd=None

    def __enter__(self):return self
    def __exit__(self,*_):self.close()


def inference_guard(*,mock=False):
    if mock:return None  # No CUDA/model load and no GPU ownership claim.
    raw,nonce=os.environ.get(FD_ENV),os.environ.get(NONCE_ENV)
    if raw is None and nonce is None:return GpuLease.acquire('inference')
    if raw is None or nonce is None or not raw.isascii() or not raw.isdecimal():raise UploadRejected('incomplete inherited GPU lease',409)
    fd=int(raw)
    lease=GpuLease.adopt(fd,nonce)
    os.close(fd)  # Adopted duplicate is the sole managed reference in this child.
    os.environ.pop(FD_ENV,None);os.environ.pop(NONCE_ENV,None)
    return lease


def status(*,root=None):
    fd=_open(default_root() if root is None else root,False)
    if fd is None:return {'busy':False,'last_record':None,'record_is_authoritative':False,'observation_only':True,'gpu_verified':False}
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);busy=False
        except BlockingIOError:busy=True
        record=_record(fd)
        diagnostic=None if record is None else {k:record[k] for k in ('kind','pid','created')}
        return {'busy':busy,'last_record':diagnostic,'record_is_authoritative':False,'observation_only':True,'gpu_verified':False}
    finally:os.close(fd)
