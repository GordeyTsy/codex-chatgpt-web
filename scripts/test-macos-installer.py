#!/usr/bin/env python3
"""Offline regression checks for installer idle/ownership gates. No app is stopped."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('macos_install', Path(__file__).with_name('macos-install.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerGates(unittest.TestCase):
    def test_idle_is_required(self):
        module.assert_idle({'accepting_turns': True, 'active_http_turns': 0, 'active_browser_turns': 0})
        for health in [
            {'accepting_turns': False, 'active_http_turns': 0, 'active_browser_turns': 0},
            {'accepting_turns': True, 'active_http_turns': 1, 'active_browser_turns': 0},
            {'accepting_turns': True, 'active_http_turns': 0, 'active_browser_turns': 1},
            {'accepting_turns': True},
        ]:
            with self.assertRaises(RuntimeError):
                module.assert_idle(health)

    def test_invalid_pid(self):
        for pid in [0, -1, True, None, '42']:
            with self.assertRaises(RuntimeError):
                module.process_identity(pid)

    def test_active_task_never_gets_signal(self):
        with tempfile.TemporaryDirectory() as temp:
            core = Path(temp)
            (core / 'config.json').write_text('{"host":"127.0.0.1"}')
            target = Path('/Applications/Codex Web GPT.app')
            comm = str(target / 'Contents/MacOS/Codex Web GPT')
            health = {'pid': 42, 'accepting_turns': True, 'active_http_turns': 1, 'active_browser_turns': 0}
            with patch.object(module, 'run', return_value=f'30 {module.os.getuid()} {comm}'), patch.object(module, 'process_identity', return_value=(str(module.os.getuid()), 'start', comm)), patch.object(module, 'daemon_request', return_value=health), patch.object(module.os, 'kill') as kill:
                with self.assertRaises(RuntimeError):
                    module.stop_owned(target, core)
                kill.assert_not_called()

    def test_mismatched_descriptor_never_gets_signal(self):
        with tempfile.TemporaryDirectory() as temp:
            core = Path(temp)
            (core / 'runtime').mkdir()
            (core / 'runtime/launcher-browser.json').write_text(json.dumps({'pid': 31}))
            target = Path('/Applications/Codex Web GPT.app')
            comm = str(target / 'Contents/MacOS/Codex Web GPT')
            with patch.object(module, 'run', return_value=f'30 {module.os.getuid()} {comm}'), patch.object(module.os, 'kill') as kill:
                with self.assertRaises(RuntimeError):
                    module.stop_owned(target, core)
                kill.assert_not_called()

    def stop_with_extra_process(self, extra_args, parent=42, active=0):
        with tempfile.TemporaryDirectory() as temp:
            core = Path(temp)
            config = {'runtimeCommand': ['/owned/runtime/bun', '/owned/runtime/app/cli.js']}
            (core / 'config.json').write_text(json.dumps(config))
            (core / 'runtime').mkdir()
            (core / 'runtime/launcher-browser.json').write_text('{"pid":30}')
            target = Path('/Applications/Codex Web GPT.app')
            comm = str(target / 'Contents/MacOS/Codex Web GPT')
            uid = str(module.os.getuid())
            health = {'pid': 42, 'accepting_turns': True, 'active_http_turns': active, 'active_browser_turns': 0}
            stopped = False

            def run(*args):
                if args == ('ps', '-axo', 'pid=,uid=,comm='):
                    return f'30 {uid} {comm}\n31 {uid} {comm}'
                if args == ('ps', '-p', '30', '-o', 'args='):
                    return comm
                if args == ('ps', '-p', '31', '-o', 'args='):
                    return comm + extra_args
                if args == ('ps', '-p', '31', '-o', 'ppid='):
                    return str(parent)
                raise AssertionError(f'Unexpected process query: {args}')

            def identity(pid):
                return None if stopped else (uid, 'start', comm if pid == 30 else '/owned/runtime/bun')

            def request(config, action=None):
                if stopped:
                    return None
                return {**health, 'accepting_turns': False} if action == 'drain' else health

            def terminate(pid, signal):
                nonlocal stopped
                self.assertEqual((pid, signal), (30, module.signal.SIGTERM))
                stopped = True

            with patch.object(module, 'run', side_effect=run), \
                    patch.object(module, 'process_identity', side_effect=identity), \
                    patch.object(module, 'daemon_request', side_effect=request), \
                    patch.object(module.os, 'kill', side_effect=terminate) as kill:
                if extra_args == ' /owned/runtime/app/browser-helper.cjs' and parent == 42 and active == 0:
                    module.stop_owned(target, core)
                    kill.assert_called_once_with(30, module.signal.SIGTERM)
                else:
                    with self.assertRaises(RuntimeError):
                        module.stop_owned(target, core)
                    kill.assert_not_called()

    def test_browser_helper_is_not_a_second_launcher(self):
        self.stop_with_extra_process(' /owned/runtime/app/browser-helper.cjs')

    def test_two_actual_launchers_still_fail_closed(self):
        self.stop_with_extra_process('')

    def test_unknown_same_executable_process_still_fails_closed(self):
        self.stop_with_extra_process(' /foreign/browser-helper.cjs')

    def test_helper_from_another_daemon_still_fails_closed(self):
        self.stop_with_extra_process(' /owned/runtime/app/browser-helper.cjs', parent=77)

    def test_active_task_with_helper_never_gets_signal(self):
        self.stop_with_extra_process(' /owned/runtime/app/browser-helper.cjs', active=1)


if __name__ == '__main__':
    unittest.main()
