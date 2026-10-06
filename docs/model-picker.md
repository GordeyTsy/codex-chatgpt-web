# Model picker regression, 2026-10-06

## Reproduction and cause

The installed `6.1.4` build from `03915d62e903c4e238792da3fa6456355671e445`
failed to launch a subagent requested as `chatgpt-web/gpt-5.6-sol`, `xhigh`.
Agent `01a10e6d-5707-7452-8ef9-034afea83365` reported
`model 5.6 could not be selected and verified`; its prompt was not sent.

Inspection of an owned, empty authenticated ChatGPT page confirmed that the power
slider and the model list both retain their layout. The inactive model list has
an ancestor with `aria-hidden=true`, `inert` and `data-active=false`. Playwright's
`isVisible()` still returns true for its radio rows. The old selector consequently
skipped opening the list and clicked behind the power slider. Playwright reported
the active slider's `Range` element intercepting pointer events until timeout.

The model-list opener also no longer carries `aria-hidden=false` itself; the
attribute belongs to its parent view. Requiring it on the opener prevented the
existing navigation fallback from working.

`selectChatGptModelFamily()` now filters radio rows and openers by both layout
visibility and the activity of their ancestors. It clicks a radio only in the
active list. If the list opens directly with the requested family already
checked, that radio must still be activated to return to the power slider; the
early return is allowed only while the slider is active. The existing exact
family, version, slider-position and pre-submission confirmation checks remain.
Unavailable modes still fail before sending, without downgrading the request.

## Targeted verification

The browser fixture reproduces the overlapping inactive view rather than hiding
it with `display:none`. It covers 100 transitions between both families and all
five power levels, including the internal lower-effort Latest staging modes.
Additional cases cover direct list activation, an already selected family,
closing on family change, nonzero slider minima, unsuccessful family selection,
and skipped slider steps. Every transition checks the retained draft and the
closed menu, followed by the production pre-submission confirmation.

The final local run passed all 112 matrix cases (166.28 s), 15 existing browser
regressions (143.23 s), 37 model/effort contract tests, and the project typecheck.

The first full build found one unrelated, flaky multipart cancellation assertion.
That fixture stubs model selection. Waiting with Bun's `.rejects` matcher delayed
its CDP events until the short acknowledgement deadline could win before owner
cancellation; direct promise awaiting preserved the intended event processing
and both fixture cases passed. Only the assertion's waiting method was changed,
keeping its error, stopped-generation, resource-release and no-final-send checks.

On the authenticated site, the source worker selected and confirmed all six
public combinations: GPT-5.6 Sol Instant/Medium/High/Extra High, GPT-5.6 Pro Max,
and GPT-6 Pro Max. It also checked four internal Latest staging levels. This
picker-only verification sent zero messages. The six public selections took
2.02–3.03 seconds each in this run; these timings exclude navigation and inference.

Reproduce from the repository root with the pinned Bun installed by the build
workflow and an installed Playwright Chromium:

```bash
export PATH="$PWD/.build-tools/bin:$PATH"
export CHATGPT_DOM_TEST_BROWSER=/home/gt/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome
bun run typecheck
timeout -k 5s 400s bun test tests/chatgpt-picker-matrix-browser.test.ts
timeout -k 5s 230s bun test tests/chatgpt-model-family-browser.test.ts tests/chatgpt-effort-browser.test.ts
bun test tests/chatgpt-model-selection.test.ts tests/chatgpt-web-models.test.ts tests/model-contract.test.ts tests/model-catalog.test.ts
timeout -k 5s 220s bun scripts/test-model-picker-live.ts
```

The last command requires the running launcher with its authenticated profile.
It leases its own temporary page and releases it in `finally`. It does not send
a conversation prompt. There is no automatic retry with another model.

Build and install the corrected runtime using the existing scripts:

```bash
bash scripts/build-appimage.sh
bash scripts/install-appimage.sh "$(cat artifacts/appimage/latest.txt)"
```

Raw local logs, the failed baseline agent, and the final installed-runtime receipt
belong in `artifacts/model-picker/`. Local fixture results and picker-only checks
are separate from the final real subagent run through the installed AppImage.
An exhausted Pro quota remains a service limitation; this change does not bypass
it. Luna/Think and Zero Risk do not use this family picker and are unchanged.
