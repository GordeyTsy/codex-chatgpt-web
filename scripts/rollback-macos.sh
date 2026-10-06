#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'macOS only' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$root/scripts/macos-install.py" rollback "$@"
