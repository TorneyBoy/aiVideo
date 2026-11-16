#!/usr/bin/env python3
"""Activate only /aiVideo/ after the isolated app is healthy; rollback on failure."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

root = Path('/opt/aivideo-replica')
release = Path(sys.argv[1]).resolve()
if release.parent != root / 'releases' or (root / '.aivideo-deployment-owner').read_text().strip() != 'aivideo-replica-v1':
    raise SystemExit('Refusing to operate outside the aiVideo deployment')

values = {}
for line in (root / '.env.server').read_text().splitlines():
    if line and not line.startswith('#'):
        name, value = line.split('=', 1)
        values[name] = json.loads(value)
authorization = 'Basic ' + base64.b64encode((values['APP_AUTH_USER'] + ':' + values['APP_AUTH_PASSWORD']).encode()).decode()

def status(url, auth=False):
    headers = {'Authorization': authorization} if auth else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as response:
        return response.code, response.read()

code, body = status('http://127.0.0.1:14173/aiVideo/api/status', True)
if code != 200 or json.loads(body).get('storage') != 'local':
    raise SystemExit('The isolated application must be healthy before changing Nginx')
old_root_status, old_root_body = status('https://huayuan.ink/')
target = Path('/etc/nginx/sites-enabled/huayuan.ink.conf').resolve()
if not str(target).startswith('/etc/nginx/'):
    raise SystemExit('Unexpected existing site configuration path')
original = target.read_bytes()
text = original.decode()
include = '    include /opt/aivideo-replica/nginx.locations.conf;'
if include not in text:
    if re.search(r'location[^\n]* /aiVideo', text):
        raise SystemExit('The requested path is already configured by another location')
    matches = list(re.finditer(r'(?m)^\s*listen\s+443\s[^;]*;', text))
    if len(matches) != 1:
        raise SystemExit('Expected exactly one IPv4 HTTPS server block')
    start = matches[0].end()
    name = re.search(r'(?m)^\s*server_name\s+huayuan\.ink\s*;', text[start:])
    if not name:
        raise SystemExit('Could not find the expected HTTPS host')
    insert = start + name.end()
    text = text[:insert] + '\n' + include + text[insert:]
snippet = root / 'nginx.locations.conf'
old_snippet = snippet.read_bytes() if snippet.exists() else None
backup_dir = root / 'backups'
backup_dir.mkdir(mode=0o700, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = backup_dir / ('huayuan.ink.conf.' + stamp)
backup.write_bytes(original)
backup.chmod(0o600)
mode = target.stat().st_mode & 0o777

def atomic_target(content):
    temporary = target.with_name(target.name + '.aivideo-staging')
    temporary.write_bytes(content)
    temporary.chmod(mode)
    os.replace(str(temporary), str(target))

try:
    shutil.copyfile(str(release / 'deploy/nginx.locations.conf'), str(snippet))
    snippet.chmod(0o644)
    atomic_target(text.encode())
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
    time.sleep(0.5)
    new_code, new_body = status('https://huayuan.ink/aiVideo/api/status', True)
    if new_code != 200 or json.loads(new_body).get('engine') != 'hypit':
        raise RuntimeError('Public aiVideo endpoint did not become healthy')
    new_root_status, new_root_body = status('https://huayuan.ink/')
    if new_root_status != old_root_status or new_root_body != old_root_body:
        raise RuntimeError('The existing root site changed during activation')
except BaseException:
    atomic_target(original)
    if old_snippet is None:
        snippet.unlink(missing_ok=True)
    else:
        snippet.write_bytes(old_snippet)
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
    raise
print(json.dumps({'activated': True, 'url': 'https://huayuan.ink/aiVideo/', 'backup': str(backup),
                  'existingRootUnchanged': True, 'originalConfigSha256': hashlib.sha256(original).hexdigest()}))
