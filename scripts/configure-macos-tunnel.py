#!/usr/bin/env python3
"""Set separate Automatic tunnel inputs on a stopped, already configured Mac launcher."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def atomic_private(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tunnel-id', required=True)
    parser.add_argument('--runtime-key-file', required=True, type=Path)
    parser.add_argument('--connector-name-suffix', required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('macOS only')
    if not re.fullmatch(r'tunnel_[A-Za-z0-9]+', args.tunnel_id):
        parser.error('Invalid Tunnel ID')
    suffix = ' '.join(args.connector_name_suffix.split())
    if not re.fullmatch(r'[\w -]{1,64}', suffix) or not suffix.strip():
        parser.error('Invalid connector name suffix')
    core = Path(os.environ.get('CODEX_CHATGPT_WEB_HOME', str(Path.home() / '.codex-chatgpt-web')))
    config_path = core / 'config.json'
    config = json.loads(config_path.read_text())
    if config.get('mode') != 'full' or config.get('browserHost') != 'launcher' or config.get('browserInteractionMode', 'automatic') != 'automatic':
        raise RuntimeError('Use the launcher MCP setup for a new installation or Zero Risk mode')
    spec = importlib.util.spec_from_file_location('macos_install', Path(__file__).with_name('macos-install.py'))
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    descriptor = core / 'runtime/launcher-browser.json'
    if descriptor.exists() and installer.process_identity(json.loads(descriptor.read_text()).get('pid')) is not None:
        raise RuntimeError('Quit the Mac launcher before changing tunnel inputs')
    if installer.daemon_request(config) is not None:
        raise RuntimeError('Quit the owned runtime before changing tunnel inputs')
    if config.get('manualTunnel', {}).get('tunnelId') == args.tunnel_id:
        raise RuntimeError('Automatic and Zero Risk require separate tunnels')
    key = args.runtime_key_file.read_bytes().strip()
    if not key or b'\n' in key or b'\r' in key:
        raise RuntimeError('Runtime key file must contain exactly one nonempty key')
    managed = core / 'secrets/tunnel-runtime-automatic.key'
    previous = managed.read_bytes() if managed.exists() else None
    tunnel = dict(config['tunnel'])
    tunnel.update(tunnelId=args.tunnel_id, runtimeKeyFile=str(managed))
    config.update(appName='Codex ' + suffix, automaticAppName='Codex ' + suffix, tunnel=tunnel, automaticTunnel=tunnel)
    # Keep the old releaseVersion so first startup runs the normal supported
    # migration, capability probe, native tunnel-client update and Codex routing.
    atomic_private(managed, key + b'\n')
    try:
        atomic_private(config_path, (json.dumps(config, indent=2) + '\n').encode())
    except BaseException:
        if previous is not None:
            atomic_private(managed, previous)
        else:
            managed.unlink()
        raise
    print(json.dumps({'connector': config['appName'], 'tunnelId': args.tunnel_id, 'runtimeKeyStoredPrivately': True, 'releaseMigrationPending': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('macOS tunnel configuration failed: ' + detail, file=sys.stderr)
        sys.exit(1)
