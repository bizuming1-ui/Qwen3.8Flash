"""Narrow RoPE bridge for reviewed qwen-tts-hf 0.1.1.post1 / TF 5.20.2.

Delegates to the upstream Apache-2.0 Qwen default initializer. No weights or
configuration files are edited. Modern theta must exist in the actual config.
See docs/KAGGLE_STEP12_AUDIT.md for wheel provenance and limitations.
"""
from __future__ import annotations
import copy
import importlib
from importlib import metadata
import math
import sys

PINS={'faster-qwen3-tts':'0.5.4','qwen-tts-hf':'0.1.1.post1','transformers':'5.20.2'}


class BackendCompatibilityError(RuntimeError):pass


def fatal_configuration_error(error):
    return isinstance(error,BackendCompatibilityError) or (isinstance(error,AttributeError) and 'rope_theta' in str(error))


def legacy_default_call(original,config,device=None,seq_len=None,layer_type=None):
    if hasattr(config,'rope_theta'):
        return original(config,device=device,seq_len=seq_len,layer_type=layer_type)
    params=getattr(config,'rope_parameters',None)
    if not isinstance(params,dict) or params.get('rope_type')!='default' or layer_type is not None:
        raise BackendCompatibilityError('unsupported modern RoPE schema/type; refusing guessed theta')
    theta=params.get('rope_theta')
    factor=params.get('partial_rotary_factor',getattr(config,'partial_rotary_factor',1.))
    if type(theta) not in (int,float) or not math.isfinite(theta) or theta<=0 or type(factor) not in (int,float) or not math.isfinite(factor) or not 0<factor<=1:
        raise BackendCompatibilityError('invalid modern RoPE theta/partial factor')
    proxy=copy.copy(config)
    proxy.rope_theta=theta;proxy.partial_rotary_factor=factor
    return original(proxy,device=device,seq_len=seq_len,layer_type=layer_type)


def bridge_registry(module,registry):
    original=module._default_rope_parameters
    if getattr(original,'_qtts_rope_bridge',False):
        if registry.get('default') is not original:raise BackendCompatibilityError('RoPE registry changed after bridge installation')
        return
    if original.__module__!='qwen_tts._transformers_compat' or original.__name__!='_default_rope_parameters' or registry.get('default') is not original:
        raise BackendCompatibilityError('unrecognized Qwen default RoPE initializer; refusing global override')
    def bridged(config,device=None,seq_len=None,layer_type=None):
        return legacy_default_call(original,config,device,seq_len,layer_type)
    bridged._qtts_rope_bridge=True
    module._default_rope_parameters=bridged
    registry['default']=bridged


def installed_version(name):
    try:return metadata.version(name)
    except metadata.PackageNotFoundError:return None


def install_qwen_rope_bridge():
    """Install BEFORE model construction, including Faster's lazy Qwen import.

    Installed HF metadata, not sys.modules membership, selects this path.
    Normal import executes Qwen's registry setup before we bridge it. Importing
    Faster alone does not import Qwen and must never silently skip this guard.
    """
    versions={name:installed_version(name) for name in PINS}
    module=sys.modules.get('qwen_tts._transformers_compat')
    if versions['qwen-tts-hf'] is None:
        if module is not None:
            raise BackendCompatibilityError('HF compatibility module loaded without HF distribution metadata')
        return {'status':'not_applicable','reason':'HF distribution not installed; legacy provider path'}
    if installed_version('qwen-tts') is not None:
        raise BackendCompatibilityError('qwen-tts and qwen-tts-hf share qwen_tts namespace; use a clean runtime')
    if versions['qwen-tts-hf']!=PINS['qwen-tts-hf'] or versions['transformers']!=PINS['transformers']:
        raise BackendCompatibilityError('unreviewed qwen-tts-hf/Transformers combination; use reviewed runtime pins')
    try:
        module=importlib.import_module('qwen_tts._transformers_compat')
    except Exception as error:
        raise BackendCompatibilityError('reviewed HF compatibility module could not be imported; refusing model load') from error

    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS
    bridge_registry(module,ROPE_INIT_FUNCTIONS)
    return {'status':'installed','versions':versions,'weights_modified':False}


def configuration_smoke():
    result=install_qwen_rope_bridge()
    if result['status']!='installed':return {**result,'model_loaded':False}
    import torch
    from transformers import MimiConfig
    from transformers.modeling_rope_utils import ROPE_INIT_FUNCTIONS
    # Actual modern Mimi class; no full model construction/download/CUDA.
    config=MimiConfig(hidden_size=32,num_attention_heads=4,rope_parameters={'rope_type':'default','rope_theta':12345.})
    before=config.to_dict();actual,scale=ROPE_INIT_FUNCTIONS['default'](config,device=torch.device('cpu'))
    expected=1./(12345.**(torch.arange(0,8,2,dtype=torch.float32)/8))
    torch.testing.assert_close(actual,expected,rtol=0,atol=0)
    if scale!=1. or before!=config.to_dict():raise BackendCompatibilityError('RoPE CPU smoke changed configuration or scale')
    return {**result,'configuration_smoke_passed':True,'model_loaded':False,'gpu_executed':False}
