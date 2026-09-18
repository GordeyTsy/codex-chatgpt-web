#!/usr/bin/env python3
"""Stop only the main Electron process whose APPIMAGE equals the supplied path."""
import os, signal, sys, time
from pathlib import Path
image=os.fsencode(str(Path(sys.argv[1]).resolve()))
pids=[]
for proc in Path('/proc').glob('[0-9]*'):
    try:
        argv=(proc/'cmdline').read_bytes().split(b'\0')
        env=(proc/'environ').read_bytes().split(b'\0')
        if b'APPIMAGE='+image in env and argv[0].endswith(b'/codex-web-gpt-launcher') and not any(a.startswith(b'--type=') for a in argv):
            pids.append(int(proc.name))
    except (OSError,IndexError):
        pass
for pid in pids:
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
for _ in range(120):
    if all(not Path('/proc',str(pid)).exists() for pid in pids):break
    time.sleep(.5)
else:raise SystemExit('Application did not stop; installation unchanged')
