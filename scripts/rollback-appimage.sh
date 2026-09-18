#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
state="$HOME/.local/state/codex-web-gpt-appimage/previous.json"
mapfile -t paths < <(python3 - "$state" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]));print(x['target']);print(x['backup'])
PY
)
[[ ${#paths[@]} == 2 ]]
target=${paths[0]} backup=${paths[1]}
test -s "$backup"
python3 "$root/scripts/stop-owned-appimage.py" "$target"
cp -p -- "$target" "$target.before-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
install -m 755 -- "$backup" "$target.new"
mv -f -- "$target.new" "$target"
nohup "$HOME/.local/bin/codex-web-gpt" > "${state%/*}/rollback-launch.log" 2>&1 < /dev/null &
pid=$!
sleep 8
kill -0 "$pid"
printf 'Restored: %s\nPID: %s\n' "$target" "$pid"
sha256sum "$target"
