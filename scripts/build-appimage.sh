#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$root/.build-tools/bin:$PATH"
for tool in bun node python3 sha256sum timeout; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
expected=$(node -p 'require("./package.json").packageManager.split("@")[1]')
[[ $(bun --version) == "$expected" ]] || { echo "Bun $expected is required (project packageManager)" >&2; exit 1; }
output="$root/artifacts/appimage"
mkdir -p "$output" "$root/artifacts/large-message-freeze/build"
log="$root/artifacts/large-message-freeze/build"
bun install --frozen-lockfile
(cd launcher && bun install --frozen-lockfile)
bun run typecheck
bun scripts/test-large-message-local.mjs > "$log/local-dom-regression.log" 2>&1 || { cat "$log/local-dom-regression.log"; exit 1; }
bun test ./tests > "$log/core-tests.log" 2>&1 || { tail -60 "$log/core-tests.log"; exit 1; }
bun run launcher:test > "$log/launcher-tests.log" 2>&1 || { tail -60 "$log/launcher-tests.log"; exit 1; }
bash "$root/scripts/prepare-linux-libnotify.sh" > "$log/libnotify.log"
export CODEX_WEB_GPT_LINUX_LIBNOTIFY="$root/launcher/build/linux-libs/libnotify.so.4"
env -u APPIMAGE_TOOLS_PATH node "$root/launcher/scripts/prepare-linux-appimage-tools.cjs" > "$log/appimage-tools.log"
export APPIMAGE_TOOLS_PATH="$root/launcher/build/appimage-tools"
bun run --cwd launcher package:linux
bun run app:smoke > "$log/smoke.log" 2>&1 || { cat "$log/smoke.log"; exit 1; }
version=$(node -p 'require("./package.json").version')
source_image="$root/launcher/artifacts/codex-web-gpt-$version-linux-$(uname -m | sed s/x86_64/x64/).AppImage"
test -s "$source_image"
commit=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
artifact="$output/codex-web-gpt-$version-${commit:0:8}-$stamp.AppImage"
install -m 755 "$source_image" "$artifact"
git diff HEAD --binary > "$artifact.patch"
git status --short > "$artifact.status"
sha256sum "$artifact" > "$artifact.sha256"
python3 - "$artifact" "$commit" <<'PY'
import sys,json,hashlib,pathlib,subprocess
p=pathlib.Path(sys.argv[1]);root=pathlib.Path.cwd()
files=subprocess.check_output(['git','ls-files','-c','-m','-o','--exclude-standard'],text=True).splitlines()
files=sorted(set(f for f in files if f.startswith(('src/','launcher/electron/','scripts/','tests/')) and pathlib.Path(f).is_file()))
manifest={'artifact':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'baseCommit':sys.argv[2],'dirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),'sourceSha256':{f:hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest() for f in files},'verification':'core tests, launcher tests, typechecks, package smoke; see artifacts/large-message-freeze/build'}
p.with_suffix('.build.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
printf '%s\n' "$artifact" > "$output/latest.txt"
cat "$artifact.sha256"
printf 'AppImage: %s\n' "$artifact"
