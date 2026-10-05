#!/usr/bin/env python3
"""Acquire an idle daemon drain only for the lifetime of the AppImage installer."""
import argparse
import errno
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def request(base, token, action=None):
    url = base + ("/healthz" if action is None else "/admin/" + action)
    req = urllib.request.Request(url, method="GET" if action is None else "POST",
                                 headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError) or getattr(error.reason, "errno", None) == errno.ECONNREFUSED:
            return None
        raise


def process_start(pid):
    try:
        return Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()[19]
    except OSError:
        return None


def release(lease_path):
    if not lease_path.exists():
        return
    lease = json.loads(lease_path.read_text())
    health = request(lease["base"], lease["token"])
    if health is None or health.get("pid") != lease["pid"] or process_start(lease["pid"]) != lease["start"]:
        # The old daemon exited. Never resume a replacement daemon's drain.
        lease_path.unlink()
        return
    resumed = request(lease["base"], lease["token"], "resume")
    if resumed is None or resumed.get("accepting_turns") is not True:
        raise RuntimeError("The original daemon did not acknowledge maintenance release")
    lease_path.unlink()


def acquire(config_path, lease_path):
    if not config_path.exists():
        return
    config = json.loads(config_path.read_text())
    host = config["host"]
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("AppImage maintenance requires a local daemon")
    base = f'http://{"[::1]" if host == "::1" else host}:{config["port"]}'
    token = config["controlToken"]
    health = request(base, token)
    if health is None:
        return
    if health.get("accepting_turns") is not True:
        raise RuntimeError("The daemon is already draining; finish its existing maintenance first")
    pid = health.get("pid")
    start = process_start(pid) if type(pid) is int and pid > 0 else None
    if start is None:
        raise RuntimeError("Cannot establish the local daemon process identity")
    if any(health.get(key) != 0 for key in ("active_http_turns", "active_browser_turns")):
        raise RuntimeError("The daemon has active turns; wait for them before installing")
    # Persist before the mutating request so even a lost response can be compensated.
    fd = os.open(lease_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"base": base, "token": token, "pid": pid, "start": start}, output)
    try:
        drained = request(base, token, "drain")
        if drained is None or drained.get("accepting_turns") is not False:
            raise RuntimeError("The daemon did not acknowledge maintenance drain")
        if any(drained.get(key) != 0 for key in ("active_http_turns", "active_browser_turns")):
            raise RuntimeError("A turn started during maintenance acquisition; installation refused")
    except BaseException:
        release(lease_path)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("acquire", "release"))
    parser.add_argument("lease", type=Path)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "acquire":
            if args.config is None:
                parser.error("acquire requires --config")
            acquire(args.config, args.lease)
        else:
            release(args.lease)
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"AppImage maintenance failed: {detail}", file=sys.stderr)
        sys.exit(1)
