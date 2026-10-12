#!/usr/bin/env python3
"""Add ONE HTTP MCP entry, preserving provider, cafe integrations and YAML comments.
Requires the existing PyYAML used by the SAAM installer; never installs renderer here.
"""
import argparse
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.request
from urllib.parse import urlparse
import yaml

def atomic(path, text):
    fd, temporary = tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as file:
            file.write(text);file.flush();os.fsync(file.fileno())
        os.chmod(temporary,0o600);os.replace(temporary,path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def merge(original, base_url):
    previous=yaml.safe_load(original) or {}
    if not isinstance(previous,dict): raise ValueError('CONFIG_NOT_A_MAPPING')
    endpoint=base_url+'/mcp'
    servers=previous.get('mcp_servers',{})
    if not isinstance(servers,dict): raise ValueError('MCP_SERVERS_REQUIRES_MANUAL_MERGE')
    block='  openreel_cloud:\n    url: '+json.dumps(endpoint)+'\n    headers:\n      Authorization: "Bearer ${OPENREEL_SERVICE_TOKEN}"\n    timeout: 60\n    connect_timeout: 30\n'
    if 'openreel_cloud' in servers:
        if servers['openreel_cloud'].get('url')!=endpoint or servers['openreel_cloud'].get('headers',{}).get('Authorization')!='Bearer ${OPENREEL_SERVICE_TOKEN}':
            raise ValueError('EXISTING_OPENREEL_ENTRY_DIFFERS: merge this entry manually; other settings have not been touched')
        return original
    matches=list(re.finditer(r'^mcp_servers:[ \t]*(?:#[^\n]*)?$',original,re.M))
    if 'mcp_servers' in previous:
        if len(matches)!=1: raise ValueError('MCP_YAML_STYLE_REQUIRES_MANUAL_MERGE')
        position=original.find('\n',matches[0].end())
        if position<0: updated=original+'\n'+block
        else: updated=original[:position+1]+block+original[position+1:]
    else: updated=original.rstrip()+'\n\nmcp_servers:\n'+block
    parsed=yaml.safe_load(updated)
    expected={**previous,'mcp_servers':{**servers,'openreel_cloud':{'url':endpoint,'headers':{'Authorization':'Bearer ${OPENREEL_SERVICE_TOKEN}'},'timeout':60,'connect_timeout':30}}}
    if parsed!=expected: raise ValueError('CONFIG_PRESERVATION_CHECK_FAILED')
    return updated

def env_merge(original, token):
    line='OPENREEL_SERVICE_TOKEN='+token
    pattern=r'^(?:export\s+)?OPENREEL_SERVICE_TOKEN=.*$'
    if re.search(pattern,original,re.M): return re.sub(pattern,lambda _:line,original,flags=re.M)
    return original.rstrip()+'\n'+line+'\n'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--url',required=True);parser.add_argument('--hermes-home',default='/root/.hermes');args=parser.parse_args()
    base_url=args.url.rstrip('/');url=urlparse(base_url)
    if url.scheme!='https' or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError('Use the real HTTPS Railway origin only, without /mcp or /api.')
    token=getpass.getpass('OpenReel cloud private key (hidden): ')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',token): raise ValueError('KEY_FORMAT: use secrets.token_urlsafe(48) when creating the Railway key')
    request=urllib.request.Request(base_url+'/api/capabilities',headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(request,timeout=20) as result:
        if json.load(result).get('version')!='0.1.0': raise ValueError('WRONG_CLOUD_SERVICE')
    home=Path(args.hermes_home);config=home/'config.yaml';env=home/'.env'
    original=config.read_text();updated=merge(original,base_url)
    old_env=env.read_text() if env.exists() else ''
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=home/('openreel-backup-'+stamp);backup.mkdir(mode=0o700)
    shutil.copy2(config,backup/'config.yaml');os.chmod(backup/'config.yaml',0o600)
    if env.exists(): shutil.copy2(env,backup/'hermes.env');os.chmod(backup/'hermes.env',0o600)
    # Both final forms have been validated before either file is written.
    try:
        atomic(env,env_merge(old_env,token));atomic(config,updated)
    except Exception:
        atomic(config,original)
        if env.exists(): atomic(env,old_env)
        raise
    print('OPENREEL_MCP_CONNECTED=openreel_cloud')
    print('PROVIDER_AND_EXISTING_MCP_PRESERVED')
    print('BACKUP='+str(backup))
    print('Hermes: /reload-mcp ; restart only the Hermes process if its running version does not reload .env')

if __name__=='__main__': main()
