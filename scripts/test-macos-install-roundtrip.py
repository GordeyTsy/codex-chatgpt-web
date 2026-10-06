#!/usr/bin/env python3
"""Exercise install + rollback against a temporary copy; never replace the real app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if sys.platform != 'darwin':
    raise SystemExit('macOS only')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('artifact', type=Path)
parser.add_argument('--previous-app', type=Path, default=Path('/Applications/Codex Web GPT.app'))
args = parser.parse_args()
installer = Path(__file__).with_name('macos-install.py').resolve()
with tempfile.TemporaryDirectory(prefix='codex-mac-rollback-test-') as scratch:
    root = Path(scratch)
    target = root / 'Codex Web GPT.app'
    archive = root / 'new.zip'
    archive.write_bytes(args.artifact.read_bytes())
    Path(str(archive) + '.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '\n')
    subprocess.run(['ditto', str(args.previous_app), str(target)], check=True, timeout=120)
    manifest_path = Path('Contents/Resources/runtime/manifest.json')
    previous = json.loads((target / manifest_path).read_text())
    core = root / 'core'
    core.mkdir()
    config = {'host': '127.0.0.1', 'port': 9, 'controlToken': 'offline-test', 'preservedPreference': True,
              'mode': 'full', 'browserHost': 'launcher', 'browserInteractionMode': 'automatic',
              'appName': 'Codex old', 'tunnel': {'tunnelId': 'tunnel_previous'}, 'releaseVersion': previous['appVersion']}
    (core / 'config.json').write_text(json.dumps(config))
    (core / 'secrets').mkdir()
    key = core / 'secrets/tunnel-runtime-automatic.key'
    key.write_text('synthetic-before')
    key.chmod(0o600)
    env = {**os.environ, 'CODEX_CHATGPT_WEB_HOME': str(core), 'CODEX_HOME': str(root / 'codex'), 'CODEX_WEB_GPT_LAUNCHER_DATA_DIR': str(root / 'data'), 'PYTHONDONTWRITEBYTECODE': '1'}
    subprocess.run([sys.executable, str(installer), 'install', str(archive), '--target', str(target), '--no-start'], check=True, env=env, timeout=180)
    installed = json.loads((target / manifest_path).read_text())
    backup = (core / 'backups/macos/latest.txt').read_text().strip()
    new_key = root / 'input.key'
    new_key.write_text('synthetic-after')
    configure = Path(__file__).with_name('configure-macos-tunnel.py').resolve()
    subprocess.run([sys.executable, str(configure), '--tunnel-id', 'tunnel_separate', '--runtime-key-file', str(new_key), '--connector-name-suffix', 'exec d'], check=True, env=env, timeout=15)
    updated = json.loads((core / 'config.json').read_text())
    assert updated['appName'] == 'Codex exec d'
    assert updated['tunnel']['tunnelId'] == 'tunnel_separate'
    assert updated['preservedPreference'] is True
    assert updated['releaseVersion'] == previous['appVersion']
    assert key.read_text().strip() == 'synthetic-after'
    subprocess.run([sys.executable, str(installer), 'rollback', backup, '--target', str(target), '--no-start'], check=True, env=env, timeout=180)
    assert json.loads((target / manifest_path).read_text()) == previous
    assert json.loads((core / 'config.json').read_text()) == config
    assert key.read_text() == 'synthetic-before'
    assert key.stat().st_mode & 0o777 == 0o600
    print(json.dumps({'kind': 'macos-isolated-install-rollback', 'ok': True, 'previousVersion': previous['appVersion'], 'installedVersion': installed['appVersion'], 'configurationRestored': True, 'privateKeyRestored': True, 'productionAppTouched': False}))
