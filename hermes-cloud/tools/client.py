#!/usr/bin/env python3
"""Stdlib-only client: lightweight HTTPS requests; never renders on the VPS."""
import argparse
import http.client
import json
import os
from pathlib import Path
import time
import urllib.request
from urllib.parse import urlparse, urlencode
import uuid

def settings():
    base=os.environ.get('OPENREEL_CLOUD_URL','').rstrip('/')
    token=os.environ.get('OPENREEL_SERVICE_TOKEN','')
    parsed=urlparse(base)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query:
        raise ValueError('Set OPENREEL_CLOUD_URL to the Railway HTTPS origin')
    if len(token)<32: raise ValueError('Set OPENREEL_SERVICE_TOKEN locally, not in chat or a public repository')
    return base,token

def api(method,path,data=None):
    base,token=settings();headers={'Authorization':'Bearer '+token}
    body=None
    if data is not None: body=json.dumps(data).encode();headers['Content-Type']='application/json'
    with urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers=headers,method=method),timeout=60) as response:
        return json.load(response)

def upload(project,file,key):
    base,token=settings();parsed=urlparse(base);source=Path(file);size=source.stat().st_size
    if size>256*1024**2: raise ValueError('Upload limit is 256 MiB')
    connection=http.client.HTTPSConnection(parsed.hostname,parsed.port or 443,timeout=120)
    connection.putrequest('POST','/api/media/upload?'+urlencode({'project_id':project,'name':source.name}))
    for k,v in {'Authorization':'Bearer '+token,'Idempotency-Key':key,'Content-Type':'application/octet-stream','Content-Length':str(size)}.items(): connection.putheader(k,v)
    connection.endheaders()
    with source.open('rb') as stream:
        while chunk:=stream.read(256*1024): connection.send(chunk)
    response=connection.getresponse();data=json.loads(response.read());connection.close()
    if response.status!=202: raise ValueError(data)
    return data

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('status');sub.add_parser('list')
    create=sub.add_parser('create');create.add_argument('name');create.add_argument('--portrait',action='store_true')
    up=sub.add_parser('upload');up.add_argument('project_id');up.add_argument('file');up.add_argument('--key',default=str(uuid.uuid4()))
    submit=sub.add_parser('submit');submit.add_argument('request_json')
    job=sub.add_parser('job');job.add_argument('id');job.add_argument('--wait',action='store_true');job.add_argument('--cancel',action='store_true')
    args=p.parse_args()
    if args.action=='status': result=api('GET','/api/capabilities')
    elif args.action=='list': result=api('GET','/api/projects')
    elif args.action=='create': result=api('POST','/api/projects',{'name':args.name,'width':720 if args.portrait else 1280,'height':1280 if args.portrait else 720,'frameRate':24})
    elif args.action=='upload': result=upload(args.project_id,args.file,args.key)
    elif args.action=='submit': result=api('POST','/api/jobs',json.loads(Path(args.request_json).read_text()))
    else:
        result=api('POST' if args.cancel else 'GET','/api/jobs/'+args.id+('/cancel' if args.cancel else ''))
        deadline=time.monotonic()+1000
        while args.wait and result['status'] in ('queued','running'):
            if time.monotonic()>deadline: raise TimeoutError('Job still running. Keep this job ID and check later; do not resubmit.')
            time.sleep(5);result=api('GET','/api/jobs/'+args.id)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
