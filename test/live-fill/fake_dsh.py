#!/usr/bin/env python3
"""Local deterministic DSH protocol stand-in. No network/model code."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from contract import validate_contract
from synthetic import artifacts, events

parser = argparse.ArgumentParser()
parser.add_argument('--profile', required=True)
parser.add_argument('--json', action='store_true')
parser.add_argument('--session-id')
parser.add_argument('prompt')
args = parser.parse_args()
turn = next(x['turn'] for x in validate_contract() if x['prompt'] == args.prompt)
cwd = Path.cwd()
sid = args.session_id or 'fake-' + cwd.name
mode = os.environ.get('FAKE_DSH_MODE', 'good')
if mode == 'exit':
    raise SystemExit(7)
if mode == 'timeout':
    child = subprocess.Popen([sys.executable, '-c', 'import time,pathlib; time.sleep(0.8); pathlib.Path("child-survived").touch()'])
    (cwd / 'child.pid').write_text(str(child.pid))
    time.sleep(10)
if mode == 'malformed':
    print('{broken')
    raise SystemExit(0)
if mode == 'session_reset' and turn == 2:
    sid = 'reset-session'
artifacts(turn, cwd)
items = events(turn, cwd, sid)
if mode == 'empty_final':
    items[-1]['text'] = ''
if mode == 'missing_usage':
    for item in items:
        item.pop('usage', None)
if mode == 'transport':
    print('ECONNRESET: connection reset', file=sys.stderr)
if mode == 'retry':
    print('retrying request after transport error', file=sys.stderr)
for item in items:
    print(json.dumps(item, ensure_ascii=False), flush=True)
if mode == 'nonzero_final':
    raise SystemExit(9)
