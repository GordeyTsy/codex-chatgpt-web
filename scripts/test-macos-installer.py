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


if __name__ == '__main__':
    unittest.main()
