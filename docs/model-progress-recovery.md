# Automatic Web model inactivity recovery

Automatic browser turns have a five-minute real-progress deadline, configured by
the optional positive `modelProgressTimeoutMs` setting (default `300000`). The
deadline starts after semantic submission acceptance. New visible model output
and actual tool requests/results advance it. Heartbeats, polling, repeated DOM
snapshots and a persistent Thinking/Stop indicator do not.

While any tool call is unresolved the deadline is suspended. The final returned
tool result starts a fresh budget, including for parallel long-running tools.
Manual Zero Risk interactions are not subject to this automatic recovery.

While the current assistant DOM node is missing, authenticated MCP activity uses
the same configured silence budget rather than the shorter renderer grace period.
An unresolved native tool call suspends this missing-node timer; its returned
result starts a fresh silence window. The timeout value also crosses the browser
helper IPC boundary. An explicit caller deadline still takes precedence.

Missing assistant identity or exhausted same-page observation rebinds produce
`chatgpt_assistant_dom_unavailable`. The bridge recovers this failure only after
the task submission was confirmed. Multipart staging and ambiguous sends do not
authorize replay. A fresh conversation retains the same native turn, capability
and completed results. This diagnostic also saves private page artifacts with
the `assistant-dom-unavailable` checkpoint and its own capture reason.

The bridge captures the inactive page, aborts and physically releases its surface,
then opens a fresh Web conversation inside the same native Codex turn. It keeps
the current MCP capability, native history and completed tool results. The recovery
prompt identifies already emitted text and requires reconciling uncertain effects;
completed effects and rejected operations must not be replayed. Ordinary queued
messages cannot inject themselves into this active native turn.

Three consecutive recoveries with no real output or tool progress are permitted.
Productive attempts reset that consecutive-empty budget. After exhaustion the
bridge returns the typed retryable `chatgpt_model_no_progress` error to native
Codex. Existing auth, quota, explicit cancellation and safety failures are unchanged.

Before releasing a timed-out surface the helper saves private evidence under the
configured browser diagnostic directory, normally `diagnostics/browser-turns`
inside the application's local data directory. The checkpoint names include
`model-progress-timeout`. Files contain a screenshot, DOM with scripts/form editors
removed, visible text and capture metadata. Capture is bounded; a broken renderer
records missing artifacts and cannot indefinitely delay recovery. Directories are
private and artifacts use mode 0600 where supported. The existing last-ten-traces
retention applies. These files can contain private conversation data: keep them
local, outside Git and safe-log exports. General logs contain only trace/path and
failure metadata. Explicit error handlers can subsequently be built from this
local evidence.
