"""Maintenance transport regressions; every daemon and artifact is test-local."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("maintenance", ROOT / "scripts/appimage-maintenance.py")
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.state = {"pid": os.getpid(), "accepting_turns": True,
                      "active_http_turns": 0, "active_browser_turns": 0}
        self.calls = []
        self.drop_drain_response = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.reply()

            def do_POST(self):
                fixture.calls.append(self.path)
                fixture.state["accepting_turns"] = self.path == "/admin/resume"
                if self.path == "/admin/drain" and fixture.drop_drain_response:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                else:
                    self.reply()

            def reply(self):
                payload = json.dumps(fixture.state).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"host": "127.0.0.1", "port": self.server.server_port,
                                           "controlToken": "test-only-control"}))
        self.lease = self.root / "lease.json"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.scratch.cleanup()

    def test_idle_drain_is_private_and_released(self):
        maintenance.acquire(self.config, self.lease)
        self.assertFalse(self.state["accepting_turns"])
        self.assertEqual(self.lease.stat().st_mode & 0o777, 0o600)
        maintenance.release(self.lease)
        maintenance.release(self.lease)
        self.assertEqual(self.calls, ["/admin/drain", "/admin/resume"])
        self.assertTrue(self.state["accepting_turns"])

    def test_active_turns_and_other_owners_drain_are_preserved(self):
        self.state["active_http_turns"] = 1
        with self.assertRaisesRegex(RuntimeError, "active turns"):
            maintenance.acquire(self.config, self.lease)
        self.state["active_http_turns"] = 0
        self.state["accepting_turns"] = False
        with self.assertRaisesRegex(RuntimeError, "already draining"):
            maintenance.acquire(self.config, self.lease)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.lease.exists())

    def test_lost_drain_response_is_compensated(self):
        self.drop_drain_response = True
        with self.assertRaises(Exception):
            maintenance.acquire(self.config, self.lease)
        self.assertTrue(self.state["accepting_turns"])
        self.assertEqual(self.calls, ["/admin/drain", "/admin/resume"])
        self.assertFalse(self.lease.exists())

    def test_replacement_daemon_is_never_resumed(self):
        maintenance.acquire(self.config, self.lease)
        self.state["pid"] += 1
        maintenance.release(self.lease)
        self.assertEqual(self.calls, ["/admin/drain"])
        self.assertFalse(self.lease.exists())

    def test_installer_term_releases_drain_and_smoke_has_its_own_codex_home(self):
        scripts = self.root / "fixture/scripts"
        scripts.mkdir(parents=True)
        for name in ("install-appimage.sh", "appimage-maintenance.py"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        marker = self.root / "stop-started"
        (scripts / "stop-owned-appimage.py").write_text(
            f'import pathlib,time\npathlib.Path({str(marker)!r}).write_text("ready")\ntime.sleep(30)\n')
        image = self.root / "image"
        smoke_observation = self.root / "smoke-codex-home"
        image.write_text(f'#!{sys.executable}\nimport os,json,pathlib\n'
                         f'pathlib.Path({str(smoke_observation)!r}).write_text(os.environ["CODEX_HOME"])\n'
                         'pathlib.Path(os.environ["CODEX_WEB_GPT_SMOKE_FILE"]).write_text(json.dumps('
                         '{"ok":True,"runtimeVerified":True,"packaged":True}))\n')
        image.chmod(0o755)
        target = self.root / "installed-image"
        shutil.copyfile(image, target)
        config_root = self.root / "core"
        config_root.mkdir()
        shutil.copyfile(self.config, config_root / "config.json")
        owner_codex = self.root / "owner-codex"
        env = dict(os.environ, HOME=str(self.root), CODEX_HOME=str(owner_codex),
                   CODEX_CHATGPT_WEB_HOME=str(config_root), CODEX_WEB_GPT_INSTALL_TARGET=str(target))
        process = subprocess.Popen(["bash", str(scripts / "install-appimage.sh"), str(image)],
                                   env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), "installer must reach stop only after drain")
            self.assertFalse(self.state["accepting_turns"])
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 143)
            self.assertTrue(self.state["accepting_turns"])
            self.assertEqual(self.calls, ["/admin/drain", "/admin/resume"])
            self.assertNotEqual(smoke_observation.read_text(), str(owner_codex))
            self.assertTrue(smoke_observation.read_text().endswith("/codex"))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()


if __name__ == "__main__":
    unittest.main()
