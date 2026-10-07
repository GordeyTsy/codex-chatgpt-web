# Native macOS fork build

The fork uses the existing Electron macOS DMG/ZIP packaging. The additional scripts
are macOS-only entry points: they reject Linux before changing installations or
configuration. Production files under `src/` and `launcher/electron/`, Linux
packaging scripts, Chromium flags, model routes, message transport and all recent
fork features are preserved. The autolink/editor performance fixes remain enabled
because they operate on Chromium/site algorithms, not on a Linux-only subsystem.

## Requirements and build

Build on macOS 13 or later, on the target architecture. This deployment was tested
on Apple Silicon with macOS 26.3.1 (a). An Intel build requires a separate native
Intel Mac; it has not been verified by this deployment.

Use Bun 1.4.0 (the version in `package.json` and both lockfiles), Node 22 and Xcode
Command Line Tools. The scripts also search `<checkout>/.build-tools/bin`, allowing
workspace-local tools without changing the system toolchain. Native Node 22.22.0
was downloaded from the official Node release and its archive SHA-256 checked:
`5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640`.
The existing application's native, signed Bun 1.4.0 was verified and reused as a
build tool. Neither lockfile nor the package manager was changed.

On the target Mac:

```bash
cd /Users/darinacygankova/projects/codex-chatgpt-web-fork
bash scripts/build-macos.sh
```

The script installs dependencies with frozen lockfiles, checks core and launcher
types/tests, verifies installer ownership gates, runs sandboxed native Electron
DOM/stress fixtures, builds the existing `launcher package:mac`, verifies package
startup, and tests install/rollback on a temporary copy when an older application
is available. Artifacts, SHA-256 sidecars, source hashes, runtime manifest and
logs go to `<checkout>/artifacts/macos/`. `latest.txt` selects the tested ZIP.

The generated application is ad hoc signed. `codesign --verify --deep --strict`
is required by packaging and installation. Developer ID signing/notarization for
public distribution requires the maintainer's certificate; this local build does
not claim notarization.

## Install and rollback

```bash
bash scripts/install-macos.sh
open '/Applications/Codex Web GPT.app'
# Inspect the actual installed bundle:
python3 -c 'import json; print(json.load(open("/Applications/Codex Web GPT.app/Contents/Resources/runtime/manifest.json"))["bundleId"])'
# Restore the saved application/configuration, preserving browser data:
bash scripts/rollback-macos.sh
```

Installation checks the ZIP checksum and native bundle signature/architecture,
refuses active tasks, drains an idle daemon and stops only the exact owned launcher
process. It does not sweep Electron/Chrome processes. Persistent backups are under
`/Users/darinacygankova/.codex-chatgpt-web/backups/macos/`; the previous application,
private configuration/secrets, launcher state and Codex configuration are retained.
Neither install nor rollback deletes the browser profile, authentication or chats.
An unsuccessful installation leaves the backup available and attempts to restore
the previous executable. `--no-start` supports configuration before first startup.

The rollback test uses `CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME` and
`CODEX_WEB_GPT_LAUNCHER_DATA_DIR` pointing only to temporary directories. It proves
that the previous bundle, connector settings and private key are restored, without
changing the production installation.

## Separate Mac tunnel

For a new installation, configure MCP through the launcher's existing MCP page.
For this already configured Mac, the first-start credentials were prepared while
the application was stopped, after its private backup:

```bash
bash scripts/install-macos.sh --no-start
PYTHONDONTWRITEBYTECODE=1 python3 scripts/configure-macos-tunnel.py \
  --tunnel-id tunnel_6ac57f9dfad08191a1e9851b6fbc99e9 \
  --runtime-key-file /Users/darinacygankova/.codex-chatgpt-web/secrets/macos-runtime-input.key \
  --connector-name-suffix 'exec d'
open '/Applications/Codex Web GPT.app'
```

The input key file must already exist with mode `0600`, populated through secure
stdin rather than a command argument. The helper atomically writes the private
managed key and changes only Automatic connector/tunnel inputs. First startup uses
the existing application's supported release migration to configure the native
tunnel-client and Codex routes. Other feature preferences are preserved.

Private configuration paths:

* `/Users/darinacygankova/.codex-chatgpt-web/config.json`
* `/Users/darinacygankova/.codex-chatgpt-web/secrets/tunnel-runtime-automatic.key`
* `/Users/darinacygankova/Library/Application Support/Codex Web GPT/launcher-state.json`

The relevant nonsecret settings are `appName = automaticAppName = "Codex exec d"`,
`browserInteractionMode = "automatic"` and the new Tunnel ID above. Secrets and
complete private configuration are deliberately excluded from this repository and
diagnostic artifacts.

After the runtime reports ready, the owner manually creates the ChatGPT connector:
choose **Tunnel**, select this separate tunnel, set **Authentication: None**, and
name it exactly **Codex exec d**. Then use the launcher's connector verification.
The connector is not created by these scripts. Full agent/MCP execution is pending
that manual step; local tests and tunnel readiness alone do not prove it.

## Targeted diagnostics

```bash
cd /Users/darinacygankova/projects/codex-chatgpt-web-fork
export PATH="$PWD/.build-tools/bin:$PATH"
bun scripts/test-macos-local.mjs
bun scripts/test-macos-local.mjs --stress
CHATGPT_DOM_TEST_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  bun test tests/chatgpt-picker-matrix-browser.test.ts tests/chatgpt-model-family-browser.test.ts
# Verify the installed Codex client's WEB catalog without sending model requests:
bun run scripts/smoke-codex-catalog.ts \
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
```

The existing official ChatGPT application includes Codex CLI 0.160.1 at this
nested path. Its native signature was verified; the official application was not
replaced. The catalog smoke uses temporary client configuration, validates grouped
models/efforts and V1 subagent overrides, then removes that temporary configuration.
It accounts for the client's native models preceding the WEB entries while still
requiring every primary WEB subagent route. Passing this smoke does not establish
that the manually created MCP connector can execute a task.

These fixtures send no real ChatGPT requests. Size labels in the inherited DOM
fixture are not UTF-8 byte counts: use the measured `units` (UTF-16 code units).
In particular, the Unicode multiline fixture at the nominal 5 MB label contains
4,587,520 units, while the single-line fixture contains 5,242,880 units. Stress runs
60 insertions at concurrency 2 with 120,000 units each, closes the renderer windows
and records remaining process metrics. It is a short local lifecycle test, not a
claim of a prolonged production stress run. On macOS, hidden windows can still
report `document.hidden = false`; the recorded state is not overridden.

The Linux-only Xvfb/timeout harness is not used on the Mac. The Mac runner launches
native Electron without Linux launch flags and keeps renderer sandboxing enabled.
