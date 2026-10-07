# File compaction fallback

Automatic Web compaction first uses the existing retained or multipart transport.
A transport failure switches that logical operation to file compaction, after the
previous physical browser owner has settled. The model and reasoning selection are
preserved. The fallback lasts three hours from the first standard failure, including
across daemon or Launcher restarts. File failures do not extend the expiry. At expiry,
the next compact tries standard transport again.

The runtime stores only a hashed browser-profile scope, expiry and failure code in
`runtime/compaction-fallback.json`, with private file permissions. No history,
credentials, account identifiers or summaries are persisted in that policy file.
Logout waits, operator cancellation, model quota exhaustion, safety denials and
incomplete file answers do not activate this transport fallback.

## File transaction

One UTF-8 attachment contains the complete ordered JSON context, including skills
in their original positions. Six Unicode-safe sections carry start/end read checks.
The short prompt contains the archive identity but does not contain those checks.
The fixed procedure opens that attachment, displays each section once in order,
then immediately returns one concise checkpoint. The loader and exact call count
are supplied, with pages bounded to 12,000 Unicode characters before the first
read. Large sections need several tool displays because native stdout is limited;
the model does not invent pagination or first print an oversized section.
Native Python instructions are provided; a native attachment reader is permitted
when Python is unavailable. Only truncated ranges may be read again. No historical command execution, external
search, test rerun, checksum calculation or intermediate summary is requested.

The final JSON must be in a fenced code block so browser-to-Markdown conversion
preserves its escapes. The bridge verifies archive identity and all six unique
read receipts before emitting only the checkpoint to native Codex. Receipt JSON
and failed-attempt prefixes are never emitted as a checkpoint. Invalid or incomplete
answers fail explicitly, leaving the original native history intact. A file attempt
does not silently retry the whole archive after another transport failure.

Read receipts detect missing sections but do not prove semantic comprehension.
Uploaded documents and read-tool output still have platform/context limits. The
browser composer budget counts the short visible prompt; that is not a claim that
the archive content is free or that the context window is larger. Exact model-side
attachment/retrieval usage is not exposed by this Web transport. Full untruncated
reads and checkpoint quality require live verification.

## Development probe

Use an explicitly selected authenticated Launcher descriptor. This source-level
probe leases its own temporary browser surface, defaults to GPT-5.6 Sol/Extra High, and uses
inert synthetic task history. It does not edit Codex routing or launch a coordinator.
GPT-6 Pro/max requires the explicit `--model pro` option.

```bash
bun run scripts/dev-compaction-file-probe.ts \
  --launcher-descriptor "$CODEX_CHATGPT_WEB_HOME/runtime/launcher-browser.json" \
  --output-dir /private/probe-output \
  --model sol \
  --padding-chars 900000
```

The output directory is private: it stores archive, raw answer, checkpoint and
coverage/fact checks. Check exact task identifiers, ownership, interrupted-vs-completed
status, source-vs-live acceptance, immutable revisions, completed effects, correction
counts, concurrency changes and next steps. Fixture coverage alone is not installed
native integration acceptance. Never commit private coordinator history or logs.
