#!/usr/bin/env python3
"""Inspect a completed adapter and publish an explicitly unverified voice profile."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'py'))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='operation',required=True)
    for name in ('describe','publish'):
        command=sub.add_parser(name);command.add_argument('--state',required=True);command.add_argument('--run-id',required=True)
        if name=='publish':
            command.add_argument('--adapter-sha256',required=True);command.add_argument('--name',required=True)
            command.add_argument('--ack-unverified-adapter',action='store_true',help='publish an unverified candidate, including one reference WAV/transcript in existing profile backup scope')
    args=parser.parse_args(argv)
    try:
        from trained_profiles import TrainedArtifacts
        store=TrainedArtifacts(args.state)
        result=store.describe(args.run_id) if args.operation=='describe' else store.publish(args.run_id,args.adapter_sha256,args.name,args.ack_unverified_adapter)
        print(json.dumps({'status':'ok','result':result},ensure_ascii=False,allow_nan=False));return 0
    except Exception as error:
        from resource_limits import UploadRejected
        code=error.code if isinstance(error,UploadRejected) else 409
        reason=str(error) if isinstance(error,UploadRejected) else 'trained artifact unavailable or invalid; inspect private local files'
        print(json.dumps({'status':'blocked' if code==503 else 'rejected','code':code,'reason':reason},ensure_ascii=False));return 2


if __name__=='__main__':raise SystemExit(main())
