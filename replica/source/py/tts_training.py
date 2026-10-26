# coding=utf-8
# Copyright 2026 The Alibaba Qwen team.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Joint-loss portion adapted; DDP/LoRA/controller integration is local.
"""Actual joint-loss/LoRA/DDP optimization. No mock-success path or model download."""
from __future__ import annotations
import contextlib
import importlib.metadata
from datetime import timedelta
import json
import os
from pathlib import Path
import random
import time

import torch
from torch import nn
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from lora_adapter import inject_lora,adapter_digest,adapter_state,restore_adapter
from tts_dataset import TTSDataset


class JointLoss(nn.Module):
    """All parameter-dependent calls INSIDE DDP.forward, never ddp.module.talker."""
    def __init__(self,core,speaker_embedding):
        super().__init__();self.core=core
        self.register_buffer('speaker_embedding',speaker_embedding.detach().clone())

    def forward(self,batch):
        talker=self.core.talker
        # Official SFT example bypasses this projection; inference applies it.
        text=talker.text_projection(talker.get_text_embeddings()(batch['input_ids'][:,:,0]))
        text=text*batch['text_embedding_mask']
        codec=talker.get_input_embeddings()(batch['input_ids'][:,:,1])*batch['codec_embedding_mask']
        if self.speaker_embedding.shape!=(1,codec.shape[-1]):raise ValueError('speaker/talker dimension mismatch')
        codec[:,6,:]=self.speaker_embedding.to(codec.dtype)
        inputs=text+codec
        for i in range(1,16):
            inputs=inputs+talker.code_predictor.get_input_embeddings()[i-1](batch['codec_ids'][:,:,i])*batch['codec_mask'].unsqueeze(-1)
        outputs=talker(inputs_embeds=inputs[:,:-1,:],attention_mask=batch['attention_mask'][:,:-1],
                       labels=batch['codec_0_labels'][:,1:],output_hidden_states=True,use_cache=False)
        hidden=outputs.hidden_states[0][-1][batch['codec_mask'][:,:-1]]
        codec_ids=batch['codec_ids'][batch['codec_mask']]
        _,sub_loss=talker.forward_sub_talker_finetune(codec_ids,hidden)
        return outputs.loss.float()+0.3*sub_loss.float()


def epoch_indices(count,epoch,seed=42,world_size=2):
    if count<world_size:raise ValueError('at least one distinct sample per rank required')
    indices=list(range(count));random.Random(seed+epoch).shuffle(indices)
    padding=(-count)%world_size;indices+=indices[:padding]
    return [indices[r::world_size] for r in range(world_size)]


def collective_true(value,device):
    flag=torch.tensor(int(bool(value)),device=device,dtype=torch.int32)
    if dist.is_initialized():dist.all_reduce(flag,op=dist.ReduceOp.MIN)
    return bool(flag.item())


def gradients_finite(parameters):
    # One host read rather than one device synchronization per LoRA tensor.
    flags=[torch.isfinite(p.grad).all() for p in parameters if p.grad is not None]
    return not flags or bool(torch.stack(flags).all().item())


def provider_version():
    from qwen_compat import installed_version
    return installed_version('qwen-tts-hf') or installed_version('qwen-tts') or 'unknown'


def optimize_epoch(model,dataset,indices,optimizer,scaler,device,accumulation=4,amp=True,progress=None):
    parameters=[p for p in model.parameters() if p.requires_grad]
    optimizer.zero_grad(set_to_none=True);losses=[];updates=0;overflows=0
    for step,index in enumerate(indices):
        group_start=(step//accumulation)*accumulation
        group_size=min(accumulation,len(indices)-group_start)
        boundary=(step+1)%accumulation==0 or step+1==len(indices)
        sync=contextlib.nullcontext() if boundary or not hasattr(model,'no_sync') else model.no_sync()
        batch={k:v.to(device) for k,v in dataset.collate_fn([dataset[index]]).items()}
        with sync:
            with torch.autocast(device_type=device.type,dtype=torch.float16,enabled=amp):loss=model(batch)
            if not collective_true(torch.isfinite(loss).all().item(),device):raise ValueError('non-finite joint loss on a rank')
            losses.append(float(loss.detach()))
            scaler.scale(loss/group_size).backward()
        if boundary:
            scaler.unscale_(optimizer)
            finite=gradients_finite(parameters)
            if collective_true(finite,device):
                torch.nn.utils.clip_grad_norm_(parameters,1.0,error_if_nonfinite=True)
                scaler.step(optimizer);scaler.update();updates+=1
            else:
                scaler.update(new_scale=max(1.,scaler.get_scale()/2));overflows+=1
            optimizer.zero_grad(set_to_none=True)
        if progress is not None:
            try:progress({'micro_step':step+1,'loss':losses[-1],'optimizer_steps':updates,'overflow_steps':overflows})
            except Exception:pass  # observation must not alter gradients or abort training
    return {'loss_mean':sum(losses)/len(losses),'optimizer_steps':updates,'overflow_steps':overflows,'seen_indices':list(indices)}


def load_adapter(core,checkpoint,base_directory):
    """Attach trained adapters to a separately loaded trusted Base; NOT deployment.

    Returns the saved reference speaker embedding. Caller must wire an explicit
    Base voice-clone prompt and independently validate/reload/listen.
    """
    from safetensors.torch import load_file
    from training_job import base_fingerprint,file_digest
    checkpoint=Path(checkpoint)
    if checkpoint.is_symlink() or any(p.is_symlink() for p in checkpoint.parents):raise ValueError('unsafe checkpoint directory')
    if {p.name for p in checkpoint.iterdir()}!={'manifest.json','adapter.safetensors','speaker.safetensors'}:raise ValueError('checkpoint members mismatch')
    file_digest(checkpoint/'manifest.json') # Reject links/non-regular metadata too.
    if (checkpoint/'manifest.json').stat().st_size>1<<20:raise ValueError('checkpoint manifest budget exceeded')
    meta=json.loads((checkpoint/'manifest.json').read_text())
    if meta['kind']!='qtts_lora_adapter' or base_fingerprint(base_directory)!=meta['base_model_sha256']:
        raise ValueError('adapter/base binding mismatch')
    for name,hashed in meta['files'].items():
        if name in ('adapter.safetensors','speaker.safetensors') and (checkpoint/name).stat().st_size>128<<20:raise ValueError('adapter file budget exceeded')
        if name not in ('adapter.safetensors','speaker.safetensors') or file_digest(checkpoint/name)!=hashed:
            raise ValueError('checkpoint hash mismatch')
    if set(meta['files'])!={'adapter.safetensors','speaker.safetensors'}:raise ValueError('checkpoint members mismatch')
    targets=inject_lora(core,meta['lora_rank'],meta['lora_alpha'])
    if targets!=meta['target_modules']:raise ValueError('adapter target modules changed')
    restore_adapter(core,load_file(str(checkpoint/'adapter.safetensors'),device='cpu'))
    speaker=load_file(str(checkpoint/'speaker.safetensors'),device='cpu')
    if set(speaker)!={'speaker_embedding'} or speaker['speaker_embedding'].shape!=(1,core.config.talker_config.hidden_size) or not torch.isfinite(speaker['speaker_embedding']).all():
        raise ValueError('invalid saved speaker embedding')
    return speaker['speaker_embedding']


def run_rank(request,rank,directory,rows):
    """Called only after inherited GPU/code leases and production admission."""
    from qwen_tts import Qwen3TTSModel
    from qwen_compat import install_qwen_rope_bridge
    install_qwen_rope_bridge()
    from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram
    from training_job import base_fingerprint,write_json,save_checkpoint
    import soundfile as sf
    device=torch.device('cuda',rank)
    if not torch.cuda.is_available() or torch.cuda.device_count()!=2:raise ValueError('exactly two visible CUDA devices required')
    torch.cuda.set_device(rank);torch.set_num_threads(2)
    torch.manual_seed(request['seed']);torch.cuda.manual_seed_all(request['seed'])
    dist.init_process_group('nccl',init_method=request['rendezvous'],rank=rank,world_size=2,timeout=timedelta(seconds=120))
    started=time.monotonic()
    try:
        if base_fingerprint(request['model_dir'])!=request['model_sha256']:raise ValueError('Base changed before load')
        qwen=Qwen3TTSModel.from_pretrained(request['model_dir'],device_map=str(device),dtype=torch.float16,
                    attn_implementation='eager',local_files_only=True,trust_remote_code=False,use_safetensors=True)
        core=qwen.model
        if core.config.tts_model_type!='base' or core.config.tts_model_size!='1b7' or core.config.talker_config.num_code_groups!=16:
            raise ValueError('only Base1.7B 12Hz/16-group contract supported')
        targets=inject_lora(core,request['lora_rank'],request['lora_alpha'])
        core.train();core.speaker_encoder.eval()
        core.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False})
        core.config.use_cache=False;core.talker.config.use_cache=False
        reference,sr=sf.read(directory/rows[0]['ref_audio'],dtype='float32')
        if sr!=24000 or reference.ndim!=1:raise ValueError('reference format changed')
        mel=mel_spectrogram(torch.from_numpy(reference).unsqueeze(0),n_fft=1024,num_mels=128,sampling_rate=24000,
                           hop_size=256,win_size=1024,fmin=0,fmax=12000).transpose(1,2)
        with torch.no_grad():speaker=core.speaker_encoder(mel.to(device=device,dtype=torch.float16))
        dataset=TTSDataset(rows,qwen.processor,core.config,mel,request['max_sequence'])
        # Check ALL tokenized lengths before any optimizer update, on both ranks.
        for index in range(len(dataset)):dataset[index]
        task=JointLoss(core,speaker)
        model=DDP(task,device_ids=[rank],output_device=rank,find_unused_parameters=True,broadcast_buffers=False)
        optimizer=torch.optim.AdamW([p for p in task.parameters() if p.requires_grad],lr=request['lr'],weight_decay=.01)
        scaler=torch.amp.GradScaler('cuda',init_scale=128.)
        initial=adapter_digest(core);reports=[]
        progress_started=time.monotonic();progress_last=[-float('inf')]
        def diagnostic_progress(row):
            now=time.monotonic()
            if now-progress_last[0]>=2:
                progress_last[0]=now
                print(json.dumps(dict(row,rank=rank,epoch=epoch,elapsed_s=now-progress_started)),flush=True)
        for epoch in range(request['epochs']):
            indices=epoch_indices(len(rows),epoch,request['seed'])[rank]
            stats=optimize_epoch(model,dataset,indices,optimizer,scaler,device,request['accumulation'],progress=diagnostic_progress)
            stats.update(epoch=epoch,seen_ids=[Path(rows[i]['audio']).stem for i in indices]);reports.append(stats)
            print(json.dumps({'rank':rank,'epoch':epoch,'loss_mean':stats['loss_mean'],'optimizer_steps':stats['optimizer_steps'],'overflow_steps':stats['overflow_steps']}),flush=True)
        final=adapter_digest(core);digests=[None,None];dist.all_gather_object(digests,final)
        updated=final!=initial and sum(x['optimizer_steps'] for x in reports)>0
        if not collective_true(updated and len(set(digests))==1,device):raise ValueError('no parameter change or ranks diverged')
        if base_fingerprint(request['model_dir'])!=request['model_sha256']:raise ValueError('Base changed during training')
        report={'rank':rank,'world_size':2,'backend':'nccl','device_name':torch.cuda.get_device_name(rank),'epochs':reports,
                'parameters_changed':updated,'adapter_sha256':final,'elapsed_seconds':time.monotonic()-started,
                'torch_version':str(torch.__version__),'qwen_tts_version':provider_version(),
                'trainable_parameters':sum(p.numel() for p in task.parameters() if p.requires_grad),
                'total_parameters':sum(p.numel() for p in task.parameters()),'precision':'fp16 with fp32 adapters','attention':'eager',
                'tokenizer_calls':dataset.tokenizer_calls,'dataset_cache_hits':dataset.cache_hits,'dataset_cache_bytes':dataset.cache_used,
                'peak_allocated_bytes':torch.cuda.max_memory_allocated(rank),'peak_reserved_bytes':torch.cuda.max_memory_reserved(rank)}
        write_json(Path(request['run_dir'])/f'rank{rank}.json',report)
        all_reports=[None,None];dist.all_gather_object(all_reports,report)
        if rank==0:
            save_checkpoint(request,core,speaker,targets,all_reports)
        dist.barrier()
    finally:dist.destroy_process_group()
