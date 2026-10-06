#!/usr/bin/env python3
"""Install/restore a local macOS ZIP, preserving user data and exact process ownership."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def run(*args, timeout=60):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def process_identity(pid):
    if type(pid) is not int or pid <= 0:
        raise RuntimeError('Invalid process identity')
    try:
        uid = run('ps', '-p', str(pid), '-o', 'uid=')
        started = run('ps', '-p', str(pid), '-o', 'lstart=')
        command = run('ps', '-p', str(pid), '-o', 'comm=')
    except subprocess.CalledProcessError:
        return None
    if not started or not command:
        return None
    return uid, started, command


def assert_idle(health):
    if health.get('accepting_turns') is not True:
        raise RuntimeError('Runtime is already draining; installation refused')
    if any(health.get(k) != 0 for k in ('active_http_turns', 'active_browser_turns')):
        raise RuntimeError('Finish active tasks before installing')


def daemon_request(config, action=None):
    host = config['host']
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError('Expected a loopback runtime')
    host = '[::1]' if host == '::1' else host
    req = urllib.request.Request(f"http://{host}:{config['port']}" + ('/admin/' + action if action else '/healthz'),
                                 method='POST' if action else 'GET', headers={'Authorization': 'Bearer ' + config['controlToken']})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError) or getattr(error.reason, 'errno', None) == 61:
            return None
        raise


def stop_owned(target, core):
    descriptor = core / 'runtime/launcher-browser.json'
    config_path = core / 'config.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else None
    health = daemon_request(config) if config else None
    expected = str(target / 'Contents/MacOS/Codex Web GPT')
    # Discover only the exact application executable owned by this user.
    matches = []
    for row in run('ps', '-axo', 'pid=,uid=,comm=').splitlines():
        fields = row.strip().split(None, 2)
        if len(fields) == 3 and fields[1] == str(os.getuid()) and fields[2] == expected:
            matches.append(int(fields[0]))
    if len(matches) > 1:
        raise RuntimeError('Multiple matching launcher owners; refusing to guess')
    pid = matches[0] if matches else None
    if descriptor.exists() and pid:
        if json.loads(descriptor.read_text()).get('pid') != pid:
            raise RuntimeError('Browser descriptor does not match application owner')
    if health and not pid:
        raise RuntimeError('Runtime exists without a matching launcher; stop it through its owner')
    if not pid:
        return
    identity = process_identity(pid)
    if identity is None or identity[0] != str(os.getuid()) or identity[2] != expected:
        raise RuntimeError('Cannot verify application process')
    drained = False
    daemon_identity = None
    try:
        if health:
            assert_idle(health)
            daemon_identity = process_identity(health['pid'])
            if daemon_identity is None or daemon_identity[0] != str(os.getuid()):
                raise RuntimeError('Cannot verify runtime process')
            # Mark before request so a lost response can also be compensated.
            drained = True
            result = daemon_request(config, 'drain')
            if not result or result.get('accepting_turns') is not False or any(result.get(k) != 0 for k in ('active_http_turns', 'active_browser_turns')):
                raise RuntimeError('Runtime did not become idle and drained')
        if process_identity(pid) != identity:
            raise RuntimeError('Application owner changed before stop')
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 35
        while process_identity(pid) == identity and time.monotonic() < deadline:
            time.sleep(.2)
        if process_identity(pid) == identity:
            raise RuntimeError('Owned application did not quit; no forced process sweep was performed')
        if health and daemon_request(config) is not None:
            raise RuntimeError('Owned runtime did not stop')
    finally:
        if drained and process_identity(health['pid']) == daemon_identity:
            current = daemon_request(config)
            if current and current.get('pid') == health['pid']:
                resumed = daemon_request(config, 'resume')
                if not resumed or resumed.get('accepting_turns') is not True:
                    raise RuntimeError('Could not release the original maintenance drain')


def validate(app):
    run('codesign', '--verify', '--deep', '--strict', str(app))
    manifest = json.loads((app / 'Contents/Resources/runtime/manifest.json').read_text())
    arch = 'arm64' if platform.machine() == 'arm64' else 'x64'
    if manifest.get('platform') != 'darwin' or manifest.get('arch') != arch:
        raise RuntimeError('Runtime platform/architecture does not match this Mac')
    return manifest


def launch(target, core):
    run('open', '-n', str(target))
    deadline = time.monotonic() + 45
    expected = str(target / 'Contents/MacOS/Codex Web GPT')
    descriptor = core / 'runtime/launcher-browser.json'
    while time.monotonic() < deadline:
        if descriptor.exists():
            try:
                identity = process_identity(json.loads(descriptor.read_text())['pid'])
                if identity and identity[0] == str(os.getuid()) and identity[2] == expected:
                    return
            except (KeyError, json.JSONDecodeError):
                pass
        time.sleep(.3)
    raise RuntimeError('Installed application did not publish its browser host')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'rollback'))
    parser.add_argument('artifact', nargs='?', type=Path, help='native ZIP, or backup directory for rollback')
    parser.add_argument('--target', type=Path, default=Path('/Applications/Codex Web GPT.app'))
    parser.add_argument('--no-start', action='store_true', help='leave stopped for explicit configuration before launch')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('macOS only; this script does not change Linux installations')
    root = Path(__file__).resolve().parent.parent
    core = Path(os.environ.get('CODEX_CHATGPT_WEB_HOME', str(Path.home() / '.codex-chatgpt-web')))
    backups = core / 'backups/macos'
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backups, 0o700)
    data = Path(os.environ.get('CODEX_WEB_GPT_LAUNCHER_DATA_DIR', str(Path.home() / 'Library/Application Support/Codex Web GPT')))
    state = data / 'launcher-state.json'
    codex = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    private_paths = [core / 'config.json', core / 'secrets', state, codex]
    artifact = args.artifact
    if artifact is None:
        artifact = Path((root / 'artifacts/macos/latest.txt').read_text().strip()) if args.action == 'install' else Path((backups / 'latest.txt').read_text().strip())
    with tempfile.TemporaryDirectory(prefix='codex-mac-install-', dir=args.target.parent) as temp:
        stage = Path(temp) / 'unpacked'
        stage.mkdir()
        if args.action == 'install':
            if artifact.suffix != '.zip':
                raise RuntimeError('Install requires the macOS ZIP produced by build-macos.sh')
            checksum_file = Path(str(artifact) + '.sha256')
            checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
            if not checksum_file.exists() or checksum_file.read_text().split()[0] != checksum:
                raise RuntimeError('ZIP SHA-256 does not match its sidecar')
            run('ditto', '-x', '-k', str(artifact), str(stage), timeout=120)
            apps = list(stage.glob('*.app'))
            if len(apps) != 1:
                raise RuntimeError('Expected exactly one application bundle')
            source = apps[0]
        else:
            # A backup is private and carries the exact target to prevent cross-install restore.
            record = json.loads((artifact / 'backup.json').read_text())
            if record['target'] != str(args.target):
                raise RuntimeError('Backup belongs to another install target')
            source = stage / args.target.name
            run('ditto', str(artifact / args.target.name), str(source), timeout=120)
        manifest = validate(source)
        stop_owned(args.target, core)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = backups / stamp
        backup.mkdir(mode=0o700)
        if args.target.exists():
            run('ditto', str(args.target), str(backup / args.target.name), timeout=120)
        entries = []
        for number, original in enumerate(private_paths):
            saved = backup / ('private-' + str(number))
            if original.exists():
                if original.is_dir():
                    shutil.copytree(original, saved)
                else:
                    shutil.copy2(original, saved)
            entries.append({'path': str(original), 'saved': saved.name, 'exists': original.exists()})
        (backup / 'backup.json').write_text(json.dumps({'target': str(args.target), 'entries': entries}, indent=2))
        (backups / 'latest.txt').write_text(str(backup) + '\n')
        displaced = Path(temp) / 'previous.app'
        if args.target.exists():
            args.target.rename(displaced)
        try:
            source.rename(args.target)
            if args.action == 'rollback':
                for entry in record['entries']:
                    original = Path(entry['path'])
                    if str(original) not in {str(p) for p in private_paths}:
                        raise RuntimeError('Backup configuration path is not owned by this installer')
                    if entry['exists']:
                        saved = artifact / entry['saved']
                        original.parent.mkdir(parents=True, exist_ok=True)
                        if saved.is_dir():
                            shutil.copytree(saved, original, dirs_exist_ok=True)
                        else:
                            shutil.copy2(saved, original)
                    # Do not delete any user data introduced since installation.
            if not args.no_start:
                launch(args.target, core)
        except BaseException:
            # Keep the failed bundle for investigation; restore the previous executable.
            stop_owned(args.target, core)
            if args.target.exists():
                args.target.rename(backup / 'failed.app')
            if displaced.exists():
                displaced.rename(args.target)
                launch(args.target, core)
            raise
        print(json.dumps({'action': args.action, 'app': str(args.target), 'version': manifest['appVersion'], 'bundleId': manifest['bundleId'], 'backup': str(backup), 'started': not args.no_start}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # subprocess output can contain credentials; never forward it here.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('macOS installation failed: ' + detail, file=sys.stderr)
        sys.exit(1)
