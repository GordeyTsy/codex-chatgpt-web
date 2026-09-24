# Large-message investigation — checkpoint for user testing

Status: **work in progress, not a fully validated fix**. The user requested that automated ChatGPT testing stop because frequent requests triggered a site warning, and requested a commit/push for manual testing. No more real-service tests should run until requested. Base commit: `e0904bc82001f06e06e7f85f564ce760c92bfd79`.

## Findings

The installed 5.0.8 runtime contained the earlier insertion patch. Its 65536-sized chunks are UTF-16 code units, not bytes. The actual editor observed is ProseMirror. Worker WebContentsView uses sandbox and disables background throttling. A view does not guarantee a dedicated renderer process.

Two independent mechanisms were reproduced:

* Native `execCommand('insertText')` is expensive on many short lines: 10 KiB insertion took 11986.7 ms, with approximately 11.4 seconds self-time in that native call in a 15.1-second profile. 100/500 KiB multiline cases exceeded a 120-second external deadline. Chunk size alone does not bound this cost. A code-rich envelope also lost exactly 65536 UTF-16 units with the prior chunk implementation; verification prevented submission.
* After submission, the site's bundled GFM email-autolink tokenizer repeatedly scans Markdown events before establishing that a candidate contains `@`. A code-rich JSON envelope triggered quadratic scanning. Approximately 8.7 of 11.36 seconds of the captured profile were in this path. The renderer remained unresponsive beyond 60 seconds in another run. This reproduced with a single native insertion too. Network acceptance and renderer responsiveness were measured separately.

The rendering compatibility change defers the history scan until an `@` candidate exists, preserving the pre-attempt event prefix. It recognizes a narrow function shape and initializes the module-local function through an owned CDP breakpoint before registration. It detaches the debugger afterward. Unknown site bundles are not modified. This is deliberately version-sensitive and needs continued validation after site updates. Sandbox and web security remain enabled.

Primary upstream algorithm: [micromark GFM autolink syntax](https://github.com/micromark/micromark-extension-gfm-autolink-literal/blob/main/dev/lib/syntax.js). The measured profile came from the actual site's bundle, not a synthetic editor.

## New-task failures

Three recent failures requested **Pro**, while the live picker exposed slider `0..3` and a Pro item with `aria-disabled=true`. Two multipart tasks staged content in Instant and failed when switching to their requested Pro; another failed before insertion. The live observation did not yield a linked explanation of why Pro was disabled. The user subsequently confirmed that the Pro quota was exhausted. This was normal service behavior, not a broken Pro selector. The actionable error and preflight remain useful without bypassing that restriction.

A new Codex CLI session explicitly using `chatgpt-web/light`, effort `low`, successfully returned `WEB_INSTANT_OK` (Markdown-escaped in the CLI output). Session: `01a0b6b0-e707-7be1-9906-11c5ca1f8459`. No automatic model downgrade was introduced.

Latest source changes expose a nonretryable `chatgpt_model_unavailable` error identifying the requested model, and preflight the final requested model before multipart staging. Existing multipart transport predates this investigation; it was not introduced by this patch. These latest error/preflight changes have not yet completed packaged runtime verification.

## Changes and message path

* `src/adapters/chatgpt-web/browser-worker.ts`: `insertPlainTextIntoComposer` replaces one affected ProseMirror paragraph for large/multiline input, preserves surrounding content/caret/connector, notifies the editor and yields; small native path retained, fallback native chunks bound lines and UTF-16 length. This insertion change still has unresolved integrity failures in the wider matrix below.
* `src/adapters/chatgpt-web/autolink-render-compat.ts`: narrow tokenizer compatibility patch and CDP lifecycle.
* `runBrowserTurn`: leased page → compatibility setup → temporary chat → model selection → `attachPrompt` → `captureSubmissionBaseline`/`sendAttachedPrompt` → assistant observation/extraction → finally release. Browser-host ownership and WebContentsView creation are in `src/launcher-browser-host.ts` and `launcher/electron/browser-host.cjs`; helper transport in `launcher-helper-client.ts`/`browser-helper-main.ts`; adapter execution/deduplication in `index.ts` and `turn-execution.ts`.
* Existing submitted-turn error handling prevents automatic replay after ambiguous submission; no retry relaxation added.
* Parser differential regressions compare complete output, including seeded fuzz, email, links, Unicode and long labels. Local Electron fixtures exercise caret, connectors, multiline and literal markup.
* Build/install/rollback scripts preserve the profile and stop only the exact installed AppImage's main process. No broad Electron/Chromium termination.

## Measurements and their limits

Numbers below are individual observations, not statistical estimates. Browser probes are not equivalent to full Codex adapter completion.

| Scenario | Insert | Send activation | User-turn detection | Responsiveness probe | Result |
|---|---:|---:|---:|---:|---|
| 198105-byte envelope, before render patch, diagnostic insertion | 2043 ms | 1111 ms | >60000 ms | timed out during freeze | Failed |
| Same envelope, render patch + single native insertion control | 764 ms | 815 ms | 488 ms | 20 ms | Answer received |
| Same envelope, both source fixes | 2643 ms | 944 ms | 1745 ms | 426 ms | Answer received |

Composer text SHA-256 matched before send in the successful envelope tests. Native and replacement insertion produced the same site-serialized outgoing string: 260779 UTF-16 units, SHA-256 `a02e7a6f9729d90de239be030b757f4247cc1e3f849e6cdeee5fc6f50e0cb2fb`. Site Markdown escaping changes the serialized representation. User-turn text readback was empty under virtualization in some probes, so complete rendered-history equality was **not** established.

Baseline matrix: 42 cases, 10 passed; six sizes (10 KiB,100 KiB,500 KiB,1 MiB,2 MiB,5 MiB), seven structures, 8-second insertion deadline. Timeouts are censored observations, not evidence that a case can never finish.

After matrix at interruption: 39 completed records, 17 passed, **9 text-integrity mismatches**, 2 closed-page failures, 11 failures because the launcher PID was no longer running. This is not a passing matrix. The integrity mismatches remain to be localized; do not claim lossless support across all tested sizes. Some runs overlapped other diagnostics/build work, so they do not establish a controlled performance comparison.

A 512000-byte transport request returned HTTP 413 while the renderer was responsive; this is a service/request limitation, not a renderer freeze. Approximately 198 KiB code-rich and 219 KiB simple synthetic messages were accepted in individual tests. No universal supported maximum has been established.

One completed envelope probe observed application-family RSS 1631240 KiB before, peak 2805868 KiB, 1651564 KiB after release; surface count returned 1→1. Summed RSS is not unique memory. This is not sufficient evidence of absence of leaks. Extended hidden/concurrent stress, cancellation, rollback, repeated full adapter completion and resource-growth validation remain incomplete.

## Checks and artifact

Earlier complete run: core 722 passed / 1 skipped; launcher 308 passed; parser/composer targeted 7 passed; local Electron DOM regression passed. After the model-unavailable changes: typecheck and browser-worker targeted suite completed (128 passed). The new complete build/test run was interrupted and is not claimed successful.

Previously built and smoke-tested, installed AppImage (does **not** contain the latest model-unavailable/preflight change):

`/home/gt/projects/my-sorted/codex-chatgpt-web/artifacts/appimage/codex-web-gpt-5.0.8-e0904bc8-20260918T214848Z.AppImage`

SHA-256: `25ebf0e3a02c42bb72383b81c9885746e02b75b5288706ac62593060149897f7`.

Its `.build.json` contains base commit and source hashes; `.patch`, `.status`, `.sha256` accompany it. The user's observation confirms the prior freeze stopped; it does not establish correctness of every case. Artifacts and raw local diagnostics are intentionally ignored by Git.

## Reproduction commands (do not run service tests until requested)

From `/home/gt/projects/my-sorted/codex-chatgpt-web`:

```bash
bash scripts/build-appimage.sh
bash scripts/install-appimage.sh
/home/gt/.local/bin/codex-web-gpt
sha256sum '/home/gt/.local/lib/codex-web-gpt/5.0.8/Codex Web GPT.AppImage'
bash scripts/rollback-appimage.sh
bash scripts/test-large-messages.sh --help
```

Build uses project-pinned Bun 1.4.0 and frozen lockfiles, typecheck, tests, packaging and AppImage smoke. Local tools currently reside in `.build-tools/bin`. Test/build fixtures require working Xvfb. No configuration file changes are required by this patch.

Commands used for the matrices:

```bash
bash scripts/test-large-messages.sh --label baseline-matrix --baseline --sizes 10240,102400,512000,1048576,2097152,5242880 --structures plain,lines,long,json,markdown,code,unicode --insert-timeout 8000
bash scripts/test-large-messages.sh --label after-matrix --render-fix --sizes 10240,102400,512000,1048576,2097152,5242880 --structures plain,lines,long,json,markdown,code,unicode --insert-timeout 8000
```

These still navigate the real site even without `--send`, and can trigger rate limits. `--send` submits synthetic requests. Avoid repeatedly running this matrix against the user's account. The frozen baseline insertion implementation is checked in at `tests/fixtures/composer-insertion-baseline.mjs`.

Local stress command (no ChatGPT requests), added but no successful completion recorded before stopping:

```bash
PATH="$PWD/.build-tools/bin:$PATH" bun scripts/test-large-message-local.mjs --stress
```

It attempts 30 cycles × 2 hidden sandboxed windows, 60 insertions total, 120000 UTF-16 units of Cyrillic/emoji/newlines each, 180-second external deadline, records process RSS and verifies exact text. It is a synthetic mechanism test, not a service end-to-end test.

Raw results: `/home/gt/projects/my-sorted/codex-chatgpt-web/artifacts/large-message-freeze/`, including `baseline-matrix`, `after-matrix`, `profile-post-send`, `combined-source`, `new-task-failure`, build logs and CPU profiles. No cookies or authentication headers are included in committed test fixtures/report.


## Upstream synchronization (2026-09-19)

Merged upstream `cea5e1c` and `eaf4f09` while retaining the fork's insertion implementation and autolink compatibility module byte-for-byte. Upstream adds nonretryable account cooldowns, persistent model-selection checks, owned HTTP 413 classification, native environment/setup recovery, and six-part Bigger Context transport when that feature is enabled. Its context multiplier stays at three; transport parts do not imply a larger model context window.

The user confirmed exhausted Pro quota, so inability to select Pro was expected service behavior. The fork retains actionable errors and preflight before any staging submission, without fallback or quota bypass. Updated upstream recovery-order fixtures now include that preflight; an additional regression verifies unavailable Pro causes zero staging sends and releases resources.

No account-bound tests are run during synchronization. A focused upstream PR is prepared separately with only autolink compatibility and its regression tests; the experimental insertion changes and local investigation files are excluded. The synchronized source does not resolve the earlier insertion-integrity matrix, and no new claim of complete real-service validation is made.

## v6.0.0 review and fork synchronization (2026-09-24)

The installed and running official runtime is v6.0.0, bundle ID
`802690f42965b3fbb2b31f58a52de7d5e24840634e36f37472404470d9ad53d8`.
The official `v6.0.0` tag is `212ceef`; upstream main additionally contains
`7579422` (localized controls and hook ownership). Neither contains the fork's
email-autolink optimization or another change to that site's tokenizer. The
release's Markdown changes concern answer extraction, not the measured site-side
email-candidate event-history scan. The installed runtime contains neither our
compatibility marker nor its initialization message.

Merged upstream main while retaining the autolink compatibility implementation
unchanged. Resolved the model-picker availability check and combined upstream
usage tracking with compatibility cleanup. The preflight preserves the requested
model family. Updated two isolated test fixtures for the renamed chat preparation
method and the compatibility initialization step.

Only local tests were run. No ChatGPT messages were sent and no account-bound
browser matrix was run. Frozen parser fixtures were rendered in a separate,
sandboxed Electron window with an external timeout. The adverse input is an
open Markdown link label containing repeated `word **bold**` runs, exercising
failed email attempts while link-label history remains open. Three runs per size:

| Input bytes | Original median (range), ms | Patched median (range), ms |
|---:|---:|---:|
| 12627 | 98.5 (75.6–113.8) | 66.1 (48.0–66.7) |
| 25227 | 374.6 (374.1–468.0) | 161.2 (134.9–193.2) |
| 50427 | 2189.3 (1755.2–2847.5) | 816.5 (599.3–1031.2) |

Complete HTML matched in all nine runs. A separate escaped-JSON control did not
show consistent improvement; it did not recreate the adverse open-label history.
A preliminary Node/Bun large-label benchmark hit its 55-second external deadline
and is not a completed comparison. These measurements concern frozen local
fixtures, not current ChatGPT assets or a v6.0.0 end-to-end submission. Therefore
this review establishes absence of an application-side fix in the release and
continued value of the preserved workaround for its recognized parser, but does
not prove that today's ChatGPT site still serves the affected bundle. The
maintainer's objection to reliance on private site internals remains valid.

Validation: frozen-lockfile install, typecheck, and 142 tests across autolink,
browser-worker contract and compaction/browser recovery passed (1151 assertions).
Raw measurements and local runners: `artifacts/large-message-freeze/v6-review/`.
The installed official application was not replaced during this fork sync.

## Current site regression (2026-09-24)

After installing the synchronized 6.0.0 build, the real launcher logged four
`tokenizer signature not recognized` events. The current loaded site asset
`conversation-small-ab2gxn0wnfhjaqoy.js` was retrieved with CDP from the existing
page, without sending a message. Its email tokenizer still calls the expensive
history guard, now named `$3e`. Our original `\w+` identifier matcher rejected
that valid JavaScript name. Therefore the workaround was present in the installed
runtime but skipped this site version.

The matcher now allows dollar identifiers, escapes captured identifiers when
constructing regexes, and uses replacement callbacks to preserve literal dollar
characters. The initialization hook's declaration matcher accepts the same names.
Unknown/ambiguous bundles still remain unchanged. Two regressions cover a real
parser renamed to a dollar identifier and dollar identifiers in every captured
binding. All five parser tests pass, including full HTML differential cases.

A sandboxed local Electron/CDP test extracted the exact current email tokenizer,
its history guard and two character predicates. A small ASCII predicate supplied
the otherwise imported character helper. It exercises growing open-label event
history with non-email candidates; this is a mechanism test, not a full Markdown
or real-service request. The actual debugger initialization hook was used. Three
runs each produced these medians:

| Candidates | Before event-property checks | Before ms | After checks | After ms |
|---:|---:|---:|---:|---:|
| 1000 | 2002000 | 44.2 | 0 | 2.3 |
| 2000 | 8004000 | 174.5 | 0 | 1.6 |
| 4000 | 32008000 | 754.2 | 0 | 5.9 |

An initial local harness placed a function declaration before the first executable
statement; its breakpoint applied after the function reference had been captured.
That run did not improve performance and was excluded. The corrected fixture has
an executable module prologue before tokenizer registration, matching the intended
production initialization order. A separate real-page initialization check is
recorded in the raw artifacts.

The observed model-picker and staging acknowledgement delays are not independently
proven defects. One blocked renderer may delay other pages; historical process
ownership was not recorded, so that propagation remains unconfirmed. No model
selection change or automatic resend was added.

Raw evidence and runners: `artifacts/large-message-freeze/current-site/`.
