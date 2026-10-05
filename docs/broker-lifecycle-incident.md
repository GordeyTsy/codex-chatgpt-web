# Broker endpoint loss during coordinator verification

## Cause and reproduction

The broker process remained alive while its public Unix socket name disappeared. A health
request restored that name from the broker's private hard link. This distinguishes pathname
removal from process death or memory exhaustion for this incident.

The coordinator was testing the preserved C checkout at `d9ffa0e`. Its adapter constructor
created a default `TurnBroker` object even for work that never started that broker.
`tests/server-lifecycle.test.ts` called `closeTurnBrokers()` during teardown. In that older
implementation, `close()` unconditionally unlinked a socket at its configured path, including
a live socket owned by another process and a broker object that had never listened.

The exact old `bun test ./tests` command was repeated with a disposable runtime home and a
separate process holding its default endpoint. Linux syscall tracing recorded a successful
`unlink` of that other process's endpoint. All 782 tests passed, with two skips, despite this
destructive cleanup. No production socket was used in this reproduction.

The earlier ownership fix `422768a` protected the running listener and retained a private hard
link. However, repair happened only on registration or `/healthz`; the older checkout could
still unlink the public name during an active turn before another health request arrived.

There was no kernel audit running at the historical unlink, so its exact historical PID cannot
be reconstructed. The old checkout/command, unsafe teardown path, live owner, and independent
syscall reproduction establish the failure mechanism rather than attributing it to an OOM.

## Repair

- Retain inode/UID/permission ownership checks; never remove or replace a foreign endpoint.
- Observe endpoint filesystem changes immediately and audit locally every five seconds.
  Re-link only the same listener inode, preserving tokens, active leases and pending results.
- Retry a missing endpoint for at most 500 ms before a connection succeeds. Never replay
  request bytes after connection or an uncertain tool outcome.
- Stop endpoint maintenance before closing the listener. Fence closing against unfinished
  startup, so shutdown cannot publish a late endpoint.
- Preload a disposable runtime home for direct Bun tests. This protection is also committed
  to the older preserved C checkout, without changing its application/browser implementation.
- Log endpoint restoration and degradation as bounded metadata, without tool payloads.

## Verification

The canonical repair is `08046c7`; C test isolation is `4111e1d`.

| Check | Result |
| --- | --- |
| Broker, server lifecycle and runtime layout regressions | 86 passed |
| Complete canonical core suite | 885 passed, 38 skipped, 0 failed |
| Complete launcher suite | 371 passed, 1 skipped, 0 failed |
| Typecheck, AppImage build and packaged smoke | Passed |
| Separate live endpoint during the entire canonical build/test process | Original inode retained |
| Older C lifecycle suite with its new test preload, under syscall tracing | 38 passed; zero unlinks of the foreign endpoint |
| Installed native MCP with a real disposable shell command | Three results, three command effects |
| Public name removed during each of those three in-flight calls | Same inode restored in 0.1–2.1 ms, mode 0600 |
| Health/registration request used to trigger those repairs | None |
| Installed manifest compared to the built manifest | Exact match |
| Existing bridge and Codex configuration hashes | Unchanged |

The rebuilt AppImage was installed with a rollback backup. These are local transport and
execution checks, without model generation, production Compose/cluster changes or credentials.
Deleting an entire runtime directory, replacing it with a foreign owner, or killing the broker
process remains a distinct failure: this repair never invents successful tool outcomes or takes
over another listener.
