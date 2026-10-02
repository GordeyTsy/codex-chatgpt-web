# Current-response delivery timeout recovery

The installed Activity renderer can display `Message delivery timed out. Please
try again.` while the native Codex turn remains active. Its error is an
`aside[role="alert"]` inside the bound exchange, with a `Retry` button and no
`regenerate-thread-error-button` test ID. The previous terminal-error detector
did not recognize it. A privacy-safe structural fixture is checked in under
`tests/fixtures/chatgpt-delivery-timeout.html`.

The response observer now recovers this specific card within the same browser
conversation. It preserves the native turn, tool journal, Markdown buffer and
completion fence. It neither submits another instruction nor selects a different
model. It waits for active generation and tool calls to settle, then activates
only the current card's exact delivery `Retry` action. The DOM cache and health
clock reset after the card disappears; pending tool-batch observations still
have to be acknowledged before completion.

Three attempts are allowed per browser turn, including across observation
reconnects. Disabled Retry or unsettled work waits at most 90 seconds; a Retry
activation must dismiss the card within 20 seconds. An unconfirmed activation
is never pressed again by that recovery object. Exhaustion or uncertainty returns
the explicit `chatgpt_message_delivery_timeout` transport error. The outer native
recovery mechanism can then reconcile unfinished work before delivering new
queued input. This is recovery, not successful completion of an assignment.

Old exchanges, hidden cards, quoted Markdown, user content and unrelated errors
do not trigger this action. Cancellation, authentication and quota handling
retain their existing behavior. Logs record only the attempt count.

Run the browser regression suite with a local Chromium executable:

```sh
CHATGPT_DOM_TEST_BROWSER=/path/to/chrome bun test tests/message-delivery-recovery.test.ts tests/browser-turn-binding.test.ts
bun run typecheck
```

These tests use isolated local pages and no provider generation. They cover
preserved response extraction, card provenance, background rendering, unsettled
tools, disabled actions, attempt exhaustion, cancellation, ambiguous controls
and unconfirmed Retry. Full installed-runtime validation is separate from these
DOM tests and package smoke.
