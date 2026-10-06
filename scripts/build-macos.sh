#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'Native macOS is required; Linux builds are unchanged.' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$root/.build-tools/bin:$PATH"
export PYTHONDONTWRITEBYTECODE=1
for tool in bun node python3 git ditto codesign shasum; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
expected=$(node -p 'require("./package.json").packageManager.split("@")[1]')
[[ $(bun --version) == "$expected" ]] || { echo "Bun $expected is required" >&2; exit 1; }
arch=$(node -p 'process.arch')
case "$arch" in arm64|x64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
[[ $(uname -m) != arm64 || "$arch" == arm64 ]] || { echo 'Use native arm64 Node on Apple Silicon' >&2; exit 1; }
output="$root/artifacts/macos"
log="$output/checks"
mkdir -p "$log"
python3 scripts/test-macos-installer.py > "$log/installer-tests.log" 2>&1
bun install --frozen-lockfile
(cd launcher && bun install --frozen-lockfile)
bun run typecheck
bun test ./tests > "$log/core-tests.log" 2>&1 || { tail -60 "$log/core-tests.log"; exit 1; }
bun run launcher:test > "$log/launcher-tests.log" 2>&1 || { tail -60 "$log/launcher-tests.log"; exit 1; }
bun scripts/test-macos-local.mjs > "$log/local-dom.log" 2>&1 || { tail -60 "$log/local-dom.log"; exit 1; }
bun scripts/test-macos-local.mjs --stress > "$log/local-stress.log" 2>&1 || { tail -60 "$log/local-stress.log"; exit 1; }
bun run --cwd launcher package:mac
bun run app:smoke > "$log/package-smoke.log" 2>&1 || { cat "$log/package-smoke.log"; exit 1; }
version=$(node -p 'require("./package.json").version')
if [[ -d '/Applications/Codex Web GPT.app' ]]; then
  python3 scripts/test-macos-install-roundtrip.py "$root/launcher/artifacts/codex-web-gpt-$version-mac-$arch.zip" > "$log/install-rollback.log" 2>&1 || { cat "$log/install-rollback.log"; exit 1; }
fi
commit=$(git rev-parse HEAD)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
base="$output/codex-web-gpt-$version-mac-$arch-${commit:0:8}-$stamp"
for extension in zip dmg; do
  test -s "$root/launcher/artifacts/codex-web-gpt-$version-mac-$arch.$extension"
  cp "$root/launcher/artifacts/codex-web-gpt-$version-mac-$arch.$extension" "$base.$extension"
  shasum -a 256 "$base.$extension" > "$base.$extension.sha256"
done
git diff HEAD --binary > "$base.patch"
git status --short > "$base.status"
python3 - "$base" "$commit" <<'PY'
import hashlib,json,pathlib,subprocess,sys
base,commit=sys.argv[1:]
manifest=json.loads(pathlib.Path('launcher/build/runtime/manifest.json').read_text())
sources=subprocess.check_output(['git','ls-files','-c','-m','-o','--exclude-standard'],text=True).splitlines()
sources=sorted(set(p for p in sources if pathlib.Path(p).is_file() and p.startswith(('src/','launcher/','scripts/','tests/'))))
result={'baseCommit':commit,'dirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),'runtime':manifest,'sourceSha256':{p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in sources},'verification':'native core/launcher tests, typechecks, synthetic DOM/stress, packaged launcher smoke'}
pathlib.Path(base+'.build.json').write_text(json.dumps(result,indent=2)+'\n')
PY
printf '%s\n' "$base.zip" > "$output/latest.txt"
cat "$base.zip.sha256" "$base.dmg.sha256"
printf 'macOS ZIP: %s\n' "$base.zip"
