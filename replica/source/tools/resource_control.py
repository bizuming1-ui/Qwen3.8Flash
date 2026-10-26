#!/usr/bin/env python3
"""Local GPU ownership status / bounded idle reservation. Does NOT run GPU work."""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'py'))
from gpu_ownership import GpuLease,status
from resource_limits import UploadRejected


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='operation',required=True)
    sub.add_parser('status')
    reserve=sub.add_parser('reserve');reserve.add_argument('--seconds',type=int,required=True)
    args=parser.parse_args(argv)
    if args.operation=='reserve' and not 1<=args.seconds<=3600:parser.error('seconds must be 1..3600')
    previous={}
    try:
        if args.operation=='status':print(json.dumps(status()));return 0
        def cancel(*_):raise KeyboardInterrupt()
        for sig in (signal.SIGINT,signal.SIGTERM):previous[sig]=signal.signal(sig,cancel)
        with GpuLease.acquire('offline-reservation'):
            print(json.dumps({'status':'offline_reserved','seconds':args.seconds,'gpu_verified':False,'training_verified':False}),flush=True)
            threading.Event().wait(args.seconds)
        print(json.dumps({'status':'released','gpu_verified':False,'training_verified':False}),flush=True);return 0
    except KeyboardInterrupt:
        print(json.dumps({'status':'cancelled','gpu_verified':False,'training_verified':False}),flush=True);return 130
    except UploadRejected as error:
        print(json.dumps({'status':'rejected','code':error.code,'reason':str(error),'gpu_verified':False}));return 2
    except OSError:
        print(json.dumps({'status':'failed','reason':'local ownership operation failed','gpu_verified':False}));return 2
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)


if __name__=='__main__':raise SystemExit(main())
