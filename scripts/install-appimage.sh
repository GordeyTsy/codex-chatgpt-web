#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source_image=${1:-$(cat "$root/artifacts/appimage/latest.txt")}
source_image=$(realpath "$source_image")
state="$HOME/.local/state/codex-web-gpt-appimage"
mkdir -p "$state"
# Reuse the existing launcher wrapper; do not change browser/profile locations.
target=${CODEX_WEB_GPT_INSTALL_TARGET:-$(python3 - <<'PY'
from pathlib import Path
import re
s=(Path.home()/'.local/bin/codex-web-gpt').read_text()
m=re.search(r"CODEX_WEB_GPT_APPIMAGE='([^']+)'",s)
if not m:raise SystemExit('Cannot identify installation; set CODEX_WEB_GPT_INSTALL_TARGET explicitly')
print(m[1])
PY
)}
test -s "$source_image"
test -f "$target"
[[ "$source_image" != "$target" ]]
# Validate the exact artifact with isolated data before stopping the installed app.
scratch=$(mktemp -d "$state/smoke-XXXXXX")
chmod +x "$source_image"
CODEX_WEB_GPT_LAUNCHER_DATA_DIR="$scratch/launcher" CODEX_CHATGPT_WEB_HOME="$scratch/core" CODEX_WEB_GPT_SMOKE_FILE="$scratch/ready.json" timeout 90 "$source_image" --launcher-smoke-test > "$scratch/smoke.log" 2>&1
python3 - "$scratch/ready.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]));assert m['ok'] and m['runtimeVerified'] and m['packaged']
PY
backup="$target.backup-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p -- "$target" "$backup"
python3 "$root/scripts/stop-owned-appimage.py" "$target"
install -m 755 -- "$source_image" "$target.new"
mv -f -- "$target.new" "$target"
python3 - "$state/previous.json" "$target" "$backup" "$source_image" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps(dict(zip(('target','backup','source'),sys.argv[2:])),indent=2)+'\n')
PY
nohup "$HOME/.local/bin/codex-web-gpt" > "$scratch/launch.log" 2>&1 < /dev/null &
pid=$!
sleep 8
if ! kill -0 "$pid" 2>/dev/null; then
 cp -p -- "$backup" "$target"
 echo "Launch failed; previous AppImage restored. Logs: $scratch" >&2
 exit 1
fi
printf 'Installed: %s\nBackup: %s\nPID: %s\nLogs: %s\n' "$target" "$backup" "$pid" "$scratch"
sha256sum "$target"
