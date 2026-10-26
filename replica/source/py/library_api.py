"""Register raw-library endpoints behind the existing authenticated Go proxy."""
import json
import re
import shutil
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as FormError
from resource_limits import UploadRejected, read_upload
from reference_segments import context_seconds


def register_library_routes(app, owner):
    # Resolve owner attributes per request so budgets/admission stay shared with
    # legacy /profiles and can be tested without importing any GPU/model.
    async def execute(function, *args):
        try:return await owner.HEAVY.run(function,*args)
        except OSError:
            owner.log.exception("raw library storage operation failed")
            return JSONResponse({"error":"library storage operation failed; refresh before retrying"},status_code=503)

    async def body(request, allowed, required):
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError("duplicate field")
                result[key]=value
            return result
        def constant(value):raise ValueError("non-finite JSON")
        try:value=json.loads(await request.body(),object_pairs_hook=unique,parse_constant=constant)
        except (ValueError,UnicodeError):raise UploadRejected("malformed or ambiguous JSON",400) from None
        if not isinstance(value,dict) or set(value)-set(allowed) or set(required)-set(value):
            raise UploadRejected("unexpected or missing JSON fields",400)
        return value

    @app.get("/training-data")
    async def training_datasets():
        def read():return {"datasets":owner.TRAINING_DATA.list(),"operation":"input_preparation_not_training"}
        return await execute(read)

    @app.post("/training-data")
    async def prepare_training_data(request:Request):
        required=("library_id","revision","samples","reference_sample_id","voice_rights_confirmed","single_speaker_confirmed")
        data=await body(request,required,required)
        def prepare():return {"dataset":owner.TRAINING_DATA.prepare(owner.LIBRARIES,data),"operation":"input_preparation_not_training"}
        return await execute(prepare)

    @app.post("/training-data/{did}/verify")
    async def verify_training_data(did:str,request:Request):
        data=await body(request,("manifest_sha256",),("manifest_sha256",))
        def verify():return {"dataset":owner.TRAINING_DATA.verify(did,data["manifest_sha256"])}
        return await execute(verify)

    @app.delete("/training-data/{did}")
    async def delete_training_data(did:str,request:Request):
        data=await body(request,("manifest_sha256",),("manifest_sha256",))
        return await execute(owner.TRAINING_DATA.delete,did,data["manifest_sha256"])

    @app.get("/libraries")
    async def libraries():
        def read():return {"libraries":owner.LIBRARIES.list(),"storage":"local-session-only; raw samples excluded from Dataset backup"}
        return await execute(read)

    @app.post("/libraries")
    async def create_library(request:Request):
        data=await body(request,("name","language"),("name",))
        def create():return {"library":owner.LIBRARIES.create(data["name"],data.get("language","auto"))}
        return await execute(create)

    @app.get("/libraries/{lid}")
    async def library(lid:str):
        def read():return {"library":owner.LIBRARIES.get(lid)}
        return await execute(read)

    @app.delete("/libraries/{lid}")
    async def delete_library(lid:str,request:Request):
        data=await body(request,("revision",),("revision",))
        return await execute(owner.LIBRARIES.remove,lid,data["revision"])

    @app.post("/libraries/{lid}/samples")
    async def upload_samples(lid:str,request:Request):
        try:
            async with request.form(max_files=owner.LIMITS.files,max_fields=1) as form:
                if set(form)-{"files","revision"} or len(form.getlist("revision"))!=1:
                    raise UploadRejected("upload requires files and one revision field",400)
                revision=form.get("revision")
                if not isinstance(revision,str) or not revision.isascii() or not revision.isdecimal() or not 0<len(revision)<=18:
                    raise UploadRejected("invalid library revision",400)
                files=form.getlist("files")
                if not files or not all(isinstance(f,UploadFile) for f in files):raise UploadRejected("upload at least one audio file",400)
                blobs=[];total=0
                for file in files:
                    data=await read_upload(file,owner.LIMITS,owner.LIMITS.request_bytes-total)
                    total+=len(data);blobs.append((file.filename or "audio",data))
                def add():return {"library":owner.LIBRARIES.add(lid,int(revision),blobs)}
                return await execute(add)
        except FormError as error:
            raise UploadRejected("multipart limits exceeded or malformed form",413 if "Too many" in str(error.detail) else 400) from None

    @app.delete("/libraries/{lid}/samples/{sid}")
    async def delete_sample(lid:str,sid:str,request:Request):
        data=await body(request,("revision",),("revision",))
        def remove():return {"library":owner.LIBRARIES.remove_sample(lid,sid,data["revision"])}
        return await execute(remove)

    @app.post("/libraries/{lid}/process")
    async def process_library(lid:str,request:Request):
        data=await body(request,("revision","sample_ids","ref_text","calibrate","anchor_seconds"),("revision","sample_ids"))
        try:anchor_seconds=context_seconds(data.get("anchor_seconds",16))
        except ValueError:raise UploadRejected("anchor_seconds must be 16 or 24",400) from None
        ref_text=data.get("ref_text","");calibrate=data.get("calibrate",False)
        if not isinstance(ref_text,str) or len(ref_text)>20000 or type(calibrate) is not bool:
            raise UploadRejected("invalid reference text or calibration flag",400)
        try:ref_text.encode("utf-8")
        except UnicodeError:raise UploadRejected("reference text contains invalid Unicode",400) from None
        # Begin + thread handoff happen in ONE admitted executor function. HTTP
        # cancellation cannot strand a live lease between those two operations.
        def launch():
            admission=owner.ADMISSION;store=owner.LIBRARIES
            if not admission.slot.acquire(blocking=False):raise UploadRejected("a voice build is already running",429)
            started=False;lease=None
            job={"id":uuid.uuid4().hex[:12],"state":"running","pct":0,"stage":"queued","log":[],"profile":None,"library":lid}
            try:
                count=sum(p.is_dir() and not p.name.startswith("_cal_") for p in owner.PROFILES_DIR.iterdir())
                if count>=owner.LIMITS.profiles:raise UploadRejected("prepared profile count budget reached",409)
                if shutil.disk_usage(owner.PROFILES_DIR).free<256<<20:raise UploadRejected("insufficient free disk space for reference processing",507)
                lease=store.begin(lid,data["revision"],data["sample_ids"],job["id"])
                class ProgressJob(dict):
                    def __setitem__(self,key,value):
                        super().__setitem__(key,value)
                        if key in ("pct","stage"):job[key]=value
                    def update(self,*args,**kwargs):
                        for key,value in dict(*args,**kwargs).items():self[key]=value
                working=ProgressJob(job)
                def run():
                    try:
                        with owner.BUILD_LOCK:
                            owner.build_profile(working,lease.metadata["name"],lease.files,lease.metadata["language"],ref_text,calibrate,**({"anchor_seconds":anchor_seconds} if anchor_seconds!=16 else {}))
                    except Exception:
                        owner.log.exception("library reference processing failed")
                        working.update(state="error",error="reference processing failed; raw samples retained")
                    finally:
                        valid_profile=isinstance(working.get("profile"),str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}",working["profile"])
                        if working.get("state")!="done" or not valid_profile:working.update(state="error",error="reference processing failed; raw samples retained")
                        try:store.finish(lease,working)
                        except Exception:
                            owner.log.exception("library processing result could not be persisted")
                            working.update(state="error",error="could not commit library result; inspect existing profiles before retrying")
                        job.update(working)
                admission.start(owner.JOBS,job,owner.LIMITS.jobs,run)
                started=True
                return {"job":job["id"],"library":lid,"operation":"reference_processing_not_training"}
            finally:
                if not started:
                    try:
                        if lease is not None:store.finish(lease,{"state":"error"})
                    finally:admission.slot.release()
        try:return await execute(launch)
        except RuntimeError:
            owner.log.exception("library processing thread could not be started")
            return JSONResponse({"error":"could not start reference processing; raw samples retained"},status_code=503)
