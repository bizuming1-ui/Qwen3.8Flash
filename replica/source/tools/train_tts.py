#!/usr/bin/env python3
"""Experimental REAL Base1.7B LoRA training, exactly two CUDA ranks. Not a mock."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'py'));sys.path.insert(0,str(Path(__file__).resolve().parent))


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--_request',help=argparse.SUPPRESS);p.add_argument('--_rank',type=int,help=argparse.SUPPRESS)
    p.add_argument('--_parent-pid',type=int,help=argparse.SUPPRESS)
    sub=p.add_subparsers(dest='operation')
    fingerprint=sub.add_parser('fingerprint');fingerprint.add_argument('--model-dir',required=True)
    train=sub.add_parser('train')
    for name in ('state','id','manifest-sha256','model-dir','model-sha256'):train.add_argument('--'+name,required=True)
    train.add_argument('--confirm-data-reviewed',action='store_true');train.add_argument('--ack-experimental-training',action='store_true')
    for name,default in [('epochs',1),('accumulation',4),('max-sequence',1024),('lora-rank',8),('seed',42),('timeout',1800)]:train.add_argument('--'+name,type=int,default=default)
    train.add_argument('--lr',type=float,default=2e-5);train.add_argument('--lora-alpha',type=float,default=16.)
    return p


def main(argv=None):
    args=parser().parse_args(argv)
    try:
        from training_job import base_fingerprint,run_controller,rank_worker
        if args._request:
            rank_worker(args._request,args._rank,args._parent_pid);return 0
        if args.operation=='fingerprint':
            result={'status':'ok','base_model_sha256':base_fingerprint(args.model_dir),'model_loaded':False}
        elif args.operation=='train':result=run_controller(args,Path(__file__).resolve())
        else:parser().error('fingerprint or train is required')
        print(json.dumps(result,ensure_ascii=False,allow_nan=False))
        return 0 if result['status'] in ('ok','completed') else 130 if result['status']=='cancelled' else 2
    except Exception as error:
        if args._request:
            import traceback
            traceback.print_exc() # Private rank log only, not the controller's public receipt.
        from resource_limits import UploadRejected
        if isinstance(error,UploadRejected):result={'status':'blocked' if error.code==503 else 'rejected','code':error.code,'reason':str(error)}
        else:result={'status':'failed','reason':'training did not complete; inspect private local run receipts'}
        print(json.dumps(result,ensure_ascii=False));return 2


if __name__=='__main__':raise SystemExit(main())
