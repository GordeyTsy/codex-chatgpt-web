# External model routes: installed verification

Verified on 2026-09-29 UTC (2026-09-30 local time), Linux x64.

## Delivered

- Optional explicit external route inventories, merged with native Codex and Web catalogs.
- Exact-model forwarding through the existing local Responses gateway; provider credentials,
  account balancing and tool conversion remain gateway-owned.
- Streaming, cancellation, compressed Codex requests and same-provider remote compaction.
- Existing 6.1.3 large-message fixes preserved.
- Local AppImage built, validated, installed and started with the existing application profile.
- Previous AppImage and private configuration backed up by the installation workflow.

Installed AppImage SHA-256:
`3d4cb6cfb882e08af1975ed0b289ee410ed52568eb6f16917a6df9a1ae1087a9`.
Its build manifest records the base commit and hashes of changed and added source files.

## Passed checks

| Check | Actual result |
| --- | --- |
| Root TypeScript check | Passed |
| Launcher TypeScript check | Passed |
| Root test suite | 822 passed, 22 skipped, 0 failed |
| Launcher test suite | 363 passed, 1 skipped, 0 failed |
| External-route regressions | 10 passed, including a real isolated HTTP server and cancellation |
| Large-message DOM regression | Passed through 5 MiB input |
| Root and launcher dependency audits | No reported vulnerabilities after bounded transitive updates |
| `bash scripts/build-appimage.sh` | Exit 0; packaging and smoke passed |
| `bash scripts/install-appimage.sh` | Exit 0; installed digest matches built artifact |
| Installed smoke | `ok=true`, `packaged=true`, `runtimeVerified=true`, version 6.1.3 |
| Installed `/v1/models` | 52 rows: 9 native, 9 Web, 6 NVIDIA, 28 Antigravity (including legacy/hidden rows) |
| Real `codex debug models` | All 52 rows deserialized successfully |
| GLM-5.3 and Gemini 3.8 Flash High metadata | Context 300000; automatic compaction 270000 |

The first `bun run verify` exposed inherited dependency advisories. A subsequent run passed
the core suite but caught an added English-only README link that violated localization parity.
The link was removed; the final build reran both complete suites successfully. No test was
disabled to obtain these results. Root/launcher package versions and Electron were not changed.

## Live generation gate: blocked by existing upstream transport

Synthetic application probes used the installed bridge, real credentials and the selected
GLM-5.3 and Gemini 3.8 Flash High routes. They did **not** complete successfully:

- NVIDIA returned HTTP 502. Egress diagnostics recorded proxy connection failures. Independent
  HTTPS CONNECT checks through all five configured NVIDIA profiles produced three HTTP 503
  failures and two timeouts, before any model request was involved.
- Antigravity's authenticated model inventory returned HTTP 200, but the application generation
  did not answer within the 240-second probe deadline. Recent manager logs contain network
  timeout indicators. A completed Gemini tool round or compaction was not observed.

Thus real provider tool calls, continuation and compaction are **not accepted yet**. Local
protocol regressions prove handling, not remote model availability. The integration does not
substitute another provider after these errors. No router, proxy assignment or provider
credential was changed during this task.

Restart Codex Desktop to refresh its in-memory catalog. Once the upstream routes are healthy,
rerun application acceptance without editing the integration:

```sh
bun run scripts/smoke-external-routes.ts
bun run scripts/smoke-external-routes.ts --generate --model=z-ai/glm-5.3
bun run scripts/smoke-external-routes.ts --generate --model=antigravity/gemini-3.8-flash-high
```

The generation probe uses only synthetic messages and an inert tool nonce. Its successful
receipt requires real streaming tool output, tool-result continuation and a real model-generated
compaction checkpoint. Credentials and raw transcripts are never printed by the probe.
