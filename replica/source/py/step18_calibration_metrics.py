"""Complete-trial calibration eligibility, not a perceptual voice-quality certificate."""
import hashlib
import math
import numpy as np

class CalibrationResult(dict):
    def __init__(self, body, status_code, *, saved, ready):
        super().__init__(body)
        self.status_code = status_code
        self.reference_saved = saved
        self.workers_ready = ready

def finite_number(value, lower, upper):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError('invalid metric')
    value = float(value)
    if not math.isfinite(value) or not lower <= value <= upper:
        raise ValueError('invalid metric')
    return value

def trial_header(index, text):
    return {'target_index': index, 'target_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
            'seed': 11 + index, 'sim': None, 'cer': None, 'sample_count': None,
            'duration_s': None, 'speaker_backend': None, 'valid': False, 'errors': []}

def failed_trials(texts, code):
    rows=[]
    for i,text in enumerate(texts):
        row=trial_header(i,text);row['errors']=[{'stage':'setup','code':code}];rows.append(row)
    return rows

def centroid_value(raw, loader):
    if raw is None:return None
    try:
        value=np.asarray(loader(raw))
        if value.ndim!=1 or not value.size or value.dtype.kind not in 'fiu' or not np.isfinite(value).all() or not np.any(value):return None
        return value
    except Exception:return None

def evaluate_trial(index, text, pid, centroid, *, synth, speaker, asr, to16k, cer, norm_text, sample_rate):
    row=trial_header(index,text)
    try:
        y,_=synth(0,pid,text,seed=row['seed'])
        y=np.asarray(y)
        if y.ndim!=1 or not y.size or y.dtype.kind not in 'fiu' or not np.isfinite(y).all() or not np.any(y) or (np.min(y)<-1 or np.max(y)>1):
            raise ValueError('invalid PCM')
        row['sample_count']=int(y.size);row['duration_s']=round(y.size/sample_rate,6)
        samples=to16k(y)
    except Exception:
        row['errors'].append({'stage':'synthesis','code':'generation_failed_or_invalid_pcm'})
        return row
    try:
        if centroid is None:raise ValueError('centroid unavailable')
        embedding=speaker.embed(samples)
        row['speaker_backend']='ecapa' if speaker.method=='ecapa' else 'unverified'
        if speaker.method!='ecapa':raise ValueError('unverified speaker backend')
        row['sim']=finite_number(speaker.sim(embedding,centroid),-1,1)
    except Exception:
        row['errors'].append({'stage':'speaker','code':'speaker_metric_unavailable'})
    try:
        _,segments=asr.transcribe(samples,None)
        hypothesis=''.join(segment['text'] for segment in segments)
        if not norm_text(hypothesis):raise ValueError('missing ASR hypothesis')
        row['cer']=finite_number(cer(text,hypothesis),0,1)
    except Exception:
        row['errors'].append({'stage':'asr','code':'asr_metric_unavailable'})
    row['valid']=not row['errors']
    return row

def summarize(candidate, trials):
    expected=len(trials);valid=sum(row['valid'] for row in trials)
    sims=[row['sim'] for row in trials if row['sim'] is not None]
    cers=[row['cer'] for row in trials if row['cer'] is not None]
    complete=bool(expected) and valid==expected
    sim=float(np.mean(sims)) if sims else None
    ce=float(np.mean(cers)) if cers else None
    return {'candidate':candidate,'trials':trials,'expected_trials':expected,'valid_trials':valid,
            'speaker_trials':len(sims),'asr_trials':len(cers),'coverage':valid/expected if expected else 0,
            'sim':round(sim,4) if sim is not None else None,'cer':round(ce,4) if ce is not None else None,
            'eligible':complete,'score':round(sim-1.5*ce,4) if complete else None}

def safe_workers(results, count):
    rows=[]
    for i in range(count):
        ok=isinstance(results,list) and len(results)==count and isinstance(results[i],dict) and results[i].get('ok') is True
        row={'worker':i,'ok':ok}
        if not ok:row['error_code']='worker_reload_unconfirmed'
        rows.append(row)
    return rows

def build_summary(result):
    return {'http_status':result.status_code,'reference_saved':result.reference_saved,
            'workers_ready':result.workers_ready,'quality_verified':False}
