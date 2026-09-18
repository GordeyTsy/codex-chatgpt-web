#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$root/.build-tools/bin:$PATH"
if [[ ${1:-} == --help ]]; then
 cat <<'HELP'
Usage: test-large-messages.sh [--label baseline|after|stress] [--sizes 10240,102400,512000,1048576,2097152,5242880]
       [--structures plain,lines,long,json,markdown,code,unicode,transport] [--iterations N]
       [--baseline] [--render-fix] [--send] [--profile] [--insert-timeout MS] [--descriptor PATH]
Each case uses a fresh launcher-owned page and an external 240s deadline.
Default: one 10 KiB plain-text insertion only. --send explicitly submits synthetic data to ChatGPT.
Sizes are UTF-8 bytes; UTF-16 length and SHA-256 are recorded separately.
These browser probes DO NOT establish full Codex/adapter completion.
Results: artifacts/large-message-freeze/<label>/*.json and optional CPU profiles.
HELP
 exit 0
fi
label=probe sizes=10240 structures=plain iterations=1
extra=()
while (($#)); do
 case "$1" in
 --label) label=$2; shift 2;;
 --sizes) sizes=$2; shift 2;;
 --structures) structures=$2; shift 2;;
 --iterations) iterations=$2; shift 2;;
 --render-fix|--baseline|--send|--profile) extra+=("$1");shift;;
 --insert-timeout|--descriptor) extra+=("$1" "$2");shift 2;;
 *) echo "Unknown option: $1" >&2;exit 2;;
 esac
done
[[ $label =~ ^[a-zA-Z0-9_-]+$ && $iterations =~ ^[1-9][0-9]*$ ]] || exit 2
IFS=, read -ra size_list <<< "$sizes"
IFS=, read -ra structure_list <<< "$structures"
out="$root/artifacts/large-message-freeze/$label"
mkdir -p "$out"
failed=0
for ((i=1;i<=iterations;i++)); do
 for size in "${size_list[@]}"; do
  [[ $size =~ ^[1-9][0-9]*$ && $size -ge 256 ]] || exit 2
  for structure in "${structure_list[@]}"; do
   timeout --kill-after=10 240 bun scripts/large-message-probe.mjs --bytes "$size" --structure "$structure" --out "$out" "${extra[@]}" >> "$out/runner.jsonl" 2>&1 || failed=$((failed+1))
  done
 done
done
printf 'Failed cases: %s; results: %s\n' "$failed" "$out"
[[ $failed == 0 ]]
