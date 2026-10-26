"""Explicit official-Qwen LoRA backend. Sentence BUFFERED, not acoustic streaming."""
from __future__ import annotations
import os
from pathlib import Path
import numpy as np
from resource_limits import UploadRejected
from trained_profiles import TrainedArtifacts,binding_of,BINDING


class AdapterEngine:
    name='qwen-adapter-buffered'
    dtype_name='fp16'
    sample_rate=24000
    supports_trained=True
    output_mode='sentence-buffered'

    def __init__(self,gpu,state,base_directory,base_hash):
        self.gpu=gpu;self.state=Path(state);self.directory=Path(base_directory).absolute();self.base_hash=base_hash
        self.artifacts=TrainedArtifacts(state);self.model=None;self.key=None;self.prompt=None

    def load(self):
        from training_job import base_fingerprint
        from trained_profiles import check_hash
        check_hash(self.base_hash)
        if base_fingerprint(self.directory)!=self.base_hash:raise UploadRejected('inference Base hash mismatch',409)
        os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
        import torch
        from qwen_tts import Qwen3TTSModel
        from qwen_compat import install_qwen_rope_bridge
        install_qwen_rope_bridge()
        if not torch.cuda.is_available():raise UploadRejected('CUDA unavailable; no trained voice inference',503)
        if torch.cuda.device_count()!=1:raise UploadRejected('adapter worker requires one visible GPU; start via supervisor',409)
        self.model=Qwen3TTSModel.from_pretrained(str(self.directory),device_map='cuda:0',dtype=torch.float16,
            attn_implementation='eager',local_files_only=True,trust_remote_code=False,use_safetensors=True)
        core=self.model.model
        if core.config.tts_model_type!='base' or core.config.tts_model_size!='1b7' or core.config.talker_config.num_code_groups!=16:
            raise UploadRejected('only Base1.7B 12Hz/16-group adapter inference supported',409)
        core.requires_grad_(False);core.eval()
        if base_fingerprint(self.directory)!=self.base_hash:raise UploadRejected('Base changed while loading inference',409)

    def _profile_now(self,profile):
        from voice_library import identifier
        identifier(profile['id'])
        # Do not let a cached profile bypass deletion/rebinding on disk.
        for directory in (self.state/'profiles',self.state/'profiles'/profile['id']):self.artifacts.fs._directory(directory)
        with self.artifacts.fs._open(self.state/'profiles'/profile['id']/'profile.json') as stream:
            raw=stream.read((256<<10)+1)
        if len(raw)>256<<10:raise UploadRejected('profile byte budget exceeded',409)
        import json
        current=json.loads(raw)
        if current.get('id')!=profile['id'] or binding_of(current)!=binding_of(profile):
            raise UploadRejected('trained profile changed; explicitly reload it',409)
        return current

    def _select(self,profile):
        """Worker lock must cover this entire call AND generation."""
        import torch
        from lora_adapter import prepare_adapter,commit_adapter
        from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem
        profile=self._profile_now(profile);binding=binding_of(profile)
        if binding['base_model_sha256']!=self.base_hash:raise UploadRejected('trained voice belongs to another Base',409)
        record=self.artifacts.inspect(binding['run_id'],binding['manifest_sha256']);m=record['manifest']
        if (m['base_model_sha256'],m['codes_id'],m['codes_manifest_sha256'])!=(self.base_hash,binding['codes_id'],binding['codes_manifest_sha256']):
            raise UploadRejected('trained voice binding mismatch',409)
        key=(profile['id'],binding['manifest_sha256'])
        if key!=self.key:
            core=self.model.model
            speaker=torch.from_numpy(record['speaker'].copy())
            if speaker.shape!=(1,core.config.talker_config.hidden_size):raise UploadRejected('speaker dimension mismatch',409)
            prepared=prepare_adapter(core,record['weights'],m['target_modules'],m['lora_rank'],m['lora_alpha'])
            vector=speaker[0].to(device=core.device,dtype=core.dtype)
            prompt=[VoiceClonePromptItem(ref_code=None,ref_spk_embedding=vector,x_vector_only_mode=True,icl_mode=False,ref_text=None)]
            commit_adapter(core,prepared)
            self.prompt=prompt;self.key=key
        return profile

    def load_profile(self,profile):
        if self.model is None:raise RuntimeError('trained backend not loaded')
        self._select(profile)
        return {'adapter_manifest_sha256':self.key[1],'model_output_mode':self.output_mode,'quality_verified':False,'inference_reload_verified':False}

    def stream(self,profile,text,language,chunk_size,max_new_tokens,seed,cancel):
        import torch
        from transformers import StoppingCriteria,StoppingCriteriaList
        if cancel.is_set():return
        profile=self._select(profile)
        class Cancel(StoppingCriteria):
            def __call__(self,input_ids,scores,**kwargs):
                return torch.full((input_ids.shape[0],),cancel.is_set(),device=input_ids.device,dtype=torch.bool)
        torch.manual_seed(int(seed)&0x7fffffff);g=profile.get('gen',{})
        with torch.inference_mode():
            waves,sr=self.model.generate_voice_clone(text=text,language=language,voice_clone_prompt=self.prompt,
                non_streaming_mode=True,max_new_tokens=int(max_new_tokens),temperature=float(g.get('temperature',.8)),
                top_k=int(g.get('top_k',50)),top_p=float(g.get('top_p',1.)),repetition_penalty=float(g.get('repetition_penalty',1.05)),
                stopping_criteria=StoppingCriteriaList([Cancel()]))
        # Cooperative cancellation cannot preempt a CUDA kernel/codec decode.
        if cancel.is_set():return
        if int(sr)!=24000 or not isinstance(waves,(list,tuple)) or len(waves)!=1:
            raise RuntimeError('native trained backend returned invalid PCM contract')
        wave=np.asarray(waves[0],dtype=np.float32)
        if wave.ndim!=1 or not 0<len(wave)<=int(max_new_tokens)*1920+24000 or not np.isfinite(wave).all() or not np.any(wave):
            raise RuntimeError('native trained backend returned invalid waveform')
        yield wave # Exactly one fully-generated sentence. Never fake acoustic chunks.

    def vram(self):
        import torch
        free,total=torch.cuda.mem_get_info()
        return {'used_mb':round((total-free)/2**20),'total_mb':round(total/2**20),'alloc_mb':round(torch.cuda.memory_allocated()/2**20)}
