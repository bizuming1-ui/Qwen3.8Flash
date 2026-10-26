"""Small native PyTorch LoRA: frozen Base, FP32 trainable A/B, no PEFT guesswork."""
from __future__ import annotations
import hashlib
import math
import torch
from torch import nn


class LoRALinear(nn.Module):
    def __init__(self,base,rank=8,alpha=16):
        super().__init__()
        if not isinstance(base,nn.Linear) or not 1<=rank<=64 or not 0<alpha<=128:
            raise ValueError('unsupported LoRA linear contract')
        self.base=base;self.rank=rank;self.alpha=float(alpha)
        self.base.requires_grad_(False)
        self.lora_A=nn.Parameter(torch.empty(rank,base.in_features,device=base.weight.device,dtype=torch.float32))
        self.lora_B=nn.Parameter(torch.zeros(base.out_features,rank,device=base.weight.device,dtype=torch.float32))
        nn.init.kaiming_uniform_(self.lora_A,a=math.sqrt(5))

    def forward(self,x):
        result=self.base(x)
        delta=(x.to(self.lora_A.dtype) @ self.lora_A.T) @ self.lora_B.T
        return result+delta.to(result.dtype)*(self.alpha/self.rank)


def inject_lora(core,rank=8,alpha=16):
    # Both talker and code_predictor attention; not speaker/tokenizer modules.
    core.requires_grad_(False)
    targets=[(name,module) for name,module in core.named_modules()
             if name.startswith('talker.') and name.endswith(('.self_attn.q_proj','.self_attn.v_proj')) and isinstance(module,nn.Linear)]
    if not targets:raise ValueError('no verified talker attention q/v linear targets')
    for name,module in targets:
        parent,_,leaf=name.rpartition('.')
        setattr(core.get_submodule(parent),leaf,LoRALinear(module,rank,alpha))
    return [name for name,_ in targets]


def adapter_state(core):
    return {name:parameter.detach().cpu().contiguous() for name,parameter in core.named_parameters()
            if name.endswith(('.lora_A','.lora_B'))}


def adapter_digest(core):
    h=hashlib.sha256()
    for name,value in sorted(adapter_state(core).items()):
        h.update(name.encode());h.update(value.numpy().tobytes())
    return h.hexdigest()


def restore_adapter(core,state):
    expected={name:p for name,p in core.named_parameters() if name.endswith(('.lora_A','.lora_B'))}
    if not expected or set(state)!=set(expected):raise ValueError('adapter members mismatch')
    for name,value in state.items():
        if value.dtype!=torch.float32 or value.shape!=expected[name].shape or not torch.isfinite(value).all():
            raise ValueError('invalid adapter tensor')
    with torch.no_grad():
        for name,value in state.items():expected[name].copy_(value)


def prepare_adapter(core,weights,targets,rank,alpha):
    """Build/validate all replacements BEFORE mutating current inference modules.

    Supports switching between different LoRA ranks. No CUDA graph reuse here.
    Caller must serialize switching and inference under the same worker lock.
    """
    expected=[name for name,module in core.named_modules()
              if name.startswith('talker.') and name.endswith(('.self_attn.q_proj','.self_attn.v_proj')) and isinstance(module,(nn.Linear,LoRALinear))]
    if not expected or targets!=expected:raise ValueError('inference adapter target modules mismatch')
    keys={name+suffix for name in targets for suffix in ('.lora_A','.lora_B')}
    if set(weights)!=keys:raise ValueError('inference adapter tensors mismatch')
    prepared=[]
    for name in targets:
        current=core.get_submodule(name);base=current.base if isinstance(current,LoRALinear) else current
        a=torch.as_tensor(weights[name+'.lora_A'].copy());b=torch.as_tensor(weights[name+'.lora_B'].copy())
        if a.dtype!=torch.float32 or b.dtype!=torch.float32 or a.shape!=(rank,base.in_features) or b.shape!=(base.out_features,rank) or not torch.isfinite(a).all() or not torch.isfinite(b).all():
            raise ValueError('inference adapter tensor shape/dtype/finite mismatch')
        layer=LoRALinear(base,rank,alpha)
        with torch.no_grad():layer.lora_A.copy_(a);layer.lora_B.copy_(b)
        layer.requires_grad_(False);layer.eval()
        parent,_,leaf=name.rpartition('.');prepared.append((core.get_submodule(parent),leaf,layer))
    return prepared


def commit_adapter(core,prepared):
    previous=[]
    try:
        for parent,leaf,layer in prepared:
            previous.append((parent,leaf,getattr(parent,leaf)));setattr(parent,leaf,layer)
    except BaseException:
        for parent,leaf,old in reversed(previous):setattr(parent,leaf,old)
        raise
