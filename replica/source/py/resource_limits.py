"""Bound untrusted multipart data before parsing and bound background admissions."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import tempfile
import threading


def positive_env(name: str, default: int, maximum: int) -> int:
    value = int(os.environ.get(name, default))
    if not 1 <= value <= maximum:
        raise ValueError(f"{name} must be in [1,{maximum}]")
    return value


@dataclass(frozen=True)
class UploadLimits:
    request_bytes: int = 128 << 20
    file_bytes: int = 64 << 20
    files: int = 16
    seconds: int = 1200
    total_seconds: int = 1800
    profiles: int = 128
    jobs: int = 64

    @classmethod
    def from_env(cls):
        return cls(positive_env("QTTS_MAX_UPLOAD_BYTES",128<<20,512<<20),
                   positive_env("QTTS_MAX_FILE_BYTES",64<<20,128<<20),
                   positive_env("QTTS_MAX_UPLOAD_FILES",16,64),
                   positive_env("QTTS_MAX_AUDIO_SECONDS",1200,1800),
                   positive_env("QTTS_MAX_TOTAL_AUDIO_SECONDS",1800,3600),
                   positive_env("QTTS_MAX_PROFILES",128,1024),
                   positive_env("QTTS_MAX_JOB_RECORDS",64,1024))


class UploadRejected(ValueError):
    def __init__(self, message: str, code: int = 413):
        super().__init__(message)
        self.code = code


async def read_upload(file, limits: UploadLimits, remaining: int) -> bytes:
    maximum = min(limits.file_bytes, remaining)
    if maximum <= 0:
        raise UploadRejected("upload total byte limit exceeded")
    chunks = []
    size = 0
    while True:
        chunk = await file.read(min(65536, maximum - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > maximum:
            raise UploadRejected("file or total upload byte limit exceeded")
        chunks.append(chunk)
    if not size:
        raise UploadRejected("empty audio files are not accepted",400)
    return b"".join(chunks)


class BodyBudgetMiddleware:
    """Spool bounded request bytes BEFORE Starlette can parse multipart or fields.

    Limits apply to unknown-length/chunked clients too. Spooling is at most 1MiB
    in RAM; the remaining bounded input uses a closed temporary file on disk.
    """
    def __init__(self, app, maximum: int, json_maximum: int = 1 << 20):
        self.app, self.maximum, self.json_maximum = app, maximum, json_maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET","HEAD","OPTIONS"):
            return await self.app(scope,receive,send)
        headers = dict(scope.get("headers",[]))
        maximum = self.maximum if headers.get(b"content-type",b"").lower().startswith(b"multipart/form-data") else self.json_maximum
        async def reject(code, message):
            import json
            body=json.dumps({"error":message}).encode()
            await send({"type":"http.response.start","status":code,"headers":[(b"content-type",b"application/json"),(b"cache-control",b"no-store")]})
            await send({"type":"http.response.body","body":body})
        if b"content-length" in headers:
            try:
                length=int(headers[b"content-length"])
                if length<0:raise ValueError()
            except ValueError:
                return await reject(400,"invalid Content-Length")
            if length>maximum:return await reject(413,"request body limit exceeded")
        with tempfile.SpooledTemporaryFile(max_size=min(maximum,1<<20),mode="w+b") as body:
            total=0
            while True:
                event=await receive()
                if event["type"]=="http.disconnect":return
                chunk=event.get("body",b"");total+=len(chunk)
                if total>maximum:return await reject(413,"request body limit exceeded")
                body.write(chunk)
                if not event.get("more_body",False):break
            body.seek(0)
            remaining=total
            finished=False
            async def replay():
                nonlocal remaining,finished
                if finished:return await receive()
                chunk=body.read(min(remaining,65536));remaining-=len(chunk)
                finished=remaining==0
                return {"type":"http.request","body":chunk,"more_body":not finished}
            await self.app(scope,replay,send)


class BuildAdmission:
    """No waiting threads: one accepted build at a time, bounded retained records."""
    def __init__(self):
        self.slot=threading.BoundedSemaphore(1)
        self.lock=threading.Lock()

    def start(self, jobs: dict, job: dict, maximum: int, target):
        with self.lock:
            while len(jobs)>=maximum:
                old=next((key for key,value in jobs.items() if value.get("state") in ("done","error")),None)
                if old is None:raise UploadRejected("job record capacity reached",429)
                del jobs[old]
            jobs[job["id"]]=job
        def runner():
            try:
                target()
            except Exception as exc:
                with self.lock:
                    job.update(state="error",error=f"{type(exc).__name__}: voice build failed")
            finally:
                with self.lock:
                    if job.get("state")=="running":
                        job.update(state="error",error="build stopped without a final state")
                self.slot.release()
        try:
            thread=threading.Thread(target=runner,daemon=True,name=f"build-{job['id']}")
            thread.start()
        except BaseException:
            with self.lock:jobs.pop(job["id"],None)
            raise


class HeavyAdmission:
    """Keep slots until executor work REALLY ends, even if HTTP awaiting it is cancelled."""
    def __init__(self, maximum: int = 2):
        self.slots=threading.BoundedSemaphore(maximum)

    async def run(self, function, *args):
        import asyncio
        if not self.slots.acquire(blocking=False):
            raise UploadRejected("analysis operation concurrency limit reached",429)
        # ThreadPoolExecutor queues BEFORE starting a worker. A failed submit
        # can therefore leave a work item which a later worker will execute.
        # Gate dispatch until submit returns; rejected work must never run or
        # release a semaphore slot a second time.
        submitted=threading.Event()
        submit_failed=False
        def work():
            submitted.wait()
            if submit_failed:return None
            try:return function(*args)
            finally:self.slots.release()
        try:
            future=asyncio.get_running_loop().run_in_executor(None,work)
        except BaseException:
            submit_failed=True
            self.slots.release()
            submitted.set()
            raise
        submitted.set()
        future.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        return await asyncio.shield(future)
