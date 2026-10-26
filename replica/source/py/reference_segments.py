"""Timestamp-preserving long reference preparation. ASR text is not human truth."""
from __future__ import annotations
import math
import unicodedata
import numpy as np


def context_seconds(value=16):
    if isinstance(value, bool) or str(value) not in ('16', '24'):
        raise ValueError('anchor_seconds must be 16 or 24')
    return int(value)


def lexical(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text) if c.isalnum())


def segment_valid(s, duration):
    try:
        a,b=float(s['start']),float(s['end'])
        return (math.isfinite(a) and math.isfinite(b) and 0 <= a < b <= duration+.02
                and isinstance(s['text'],str) and bool(lexical(s['text'])))
    except (KeyError,ValueError,TypeError):
        return False


def split_words(s, maximum):
    """None means no trustworthy word partition; NEVER proportional text slicing."""
    words=s.get('words') or []
    if not words:return None
    clean=[];previous=float(s['start'])
    try:
        for a,b,text in words:
            a,b=float(a),float(b)
            if (not math.isfinite(a+b) or a < previous-.001 or b <= a or
                    a < s['start']-.02 or b > s['end']+.02 or b-a > maximum or not isinstance(text,str)):
                return None
            previous=b;clean.append((a,b,text))
    except (TypeError,ValueError):return None
    if lexical(''.join(w[2] for w in clean)) != lexical(s['text']):return None
    result=[];group=[]
    def save():
        result.append(dict(s,start=group[0][0],end=group[-1][1],text=''.join(w[2] for w in group).strip(),words=group.copy()))
    for word in clean:
        if group and word[1]-group[0][0] > maximum:
            save();group=[]
        group.append(word)
    if group:save()
    return result


def window_end(y, sr, start, stop):
    """Prefer a low-energy 100ms boundary in the last1s; not an acoustic aligner."""
    if stop >= len(y):return len(y)
    block=max(1,int(sr*.1));low=max(start+int(sr*2.5),stop-sr)
    if stop-low < block:return stop
    starts=list(range(low,stop-block+1,block))
    if not starts:return stop
    energy=[float(np.mean(y[i:i+block].astype(np.float64)**2)) for i in starts]
    best=int(np.argmin(energy))
    # Only shift if materially quieter than the local typical energy.
    if energy[best] < max(float(np.median(energy))*.3,1e-10):return starts[best]+block
    return stop


def prepare_segments(y16, segments, language, transcribe, maximum=16, progress=None):
    maximum=context_seconds(maximum);sr=16000;duration=len(y16)/sr
    report={'input_segments':len(segments),'word_split_segments':0,'asr_windows':0,'invalid_segments':0,
            'anchor_limit_s':maximum,'text_is_asr_not_human_verified':True}
    out=[]
    for s in segments:
        if not segment_valid(s,duration):
            report['invalid_segments']+=1
            continue
        s=dict(s,start=float(s['start']),end=min(float(s['end']),duration),words=s.get('words') or [])
        if s['end']-s['start'] <= maximum:
            # Segment-level ASR timing is usable even when word-level metadata is not.
            # Never let corrupt optional words crash later pause/prosody analysis.
            if s['words'] and split_words(s,maximum) is None:s['words']=[]
            out.append(s);continue
        split=split_words(s,maximum)
        if split:
            out.extend(split);report['word_split_segments']+=len(split);continue
        begin=int(round(s['start']*sr));end=min(len(y16),int(round(s['end']*sr)))
        while begin < end:
            stop=window_end(y16,sr,begin,min(end,begin+maximum*sr))
            if not begin < stop <= end:raise RuntimeError('reference window failed to advance')
            if stop-begin < sr*1.5: # Keep short trailing audio in analysis receipt, never pair it with previous full text.
                report['short_tail_s']=report.get('short_tail_s',0)+(stop-begin)/sr
                break
            report['asr_windows']+=1
            if progress:progress(report['asr_windows'],begin/sr,stop/sr)
            lg,local=transcribe(y16[begin:stop],language)
            language=language or lg
            for p in local:
                if not segment_valid(p,(stop-begin)/sr):
                    report['invalid_segments']+=1;continue
                p=dict(p);p['start']=float(p['start'])+begin/sr;p['end']=min(float(p['end'])+begin/sr,stop/sr)
                p['words']=[(float(a)+begin/sr,float(b)+begin/sr,t) for a,b,t in (p.get('words') or [])
                            if isinstance(a,(int,float)) and isinstance(b,(int,float)) and math.isfinite(a+b)
                            and 0 <= a < b <= (stop-begin)/sr+.02]
                out.append(p)
            begin=stop
    out.sort(key=lambda p:(p['start'],p['end']))
    report['output_segments']=len(out)
    return language,out,report
