# Antigravity Codex sync in the multi-provider bridge

The importer consumes the configuration produced by Antigravity Manager's **Codex AI**
sync handler, `POST /api/proxy/cli/sync`, with `app_type: "Codex"`. It does not
use defaults from another client integration. Model budgets are read from the
handler export rather than maintained in a second model-family lookup table.

The checked-in fixture was exported by executing that handler in an isolated
instance of the current fork's 4.9.1 image. The container had no network, account
data or production mounts and used disposable authentication. No models were
invoked. The export contains only model IDs, public endpoint defaults and the
image digest; it contains no authentication material.

For that manager version, ordinary Codex sync sets:

| Family | `model_context_window` | `model_auto_compact_token_limit` |
| --- | ---: | ---: |
| Gemini | 1024000 | 1024000 |
| Claude | 256000 | 256000 |
| Other models | 128000 | 128000 |

It selects `custom`, `wire_api = "responses"`, `requires_openai_auth = true` and
provider name `Custom Node`. These are configured budgets. Codex can apply its
own effective-window percentage and clamp its actual compaction threshold.

## Applying the export

Run the importer from this repository with explicit absolute paths:

```sh
bun scripts/sync-antigravity-codex.ts \
  --contracts /private/codex-sync-contracts.json \
  --catalog /private/desktop-models.json \
  --routes /private/external-routes.json \
  --gateway /private/antigravity-models.json \
  --config /private/codex/config.toml
```

The default is a validation-only preview. Add `--apply --backup-dir
/private/new-backup-directory` to write the reviewed result. Existing backups
are never overwritten. Changed files are backed up with private permissions
and before/after hashes. Writes are atomic per file; detected write failures
roll back this process's unchanged writes without overwriting another writer.
Run during maintenance: the four-file update is not a cross-process transaction.

The import updates the Antigravity model catalog, route inventory and gateway
aliases, and writes opt-in `antigravity_<model_id>.config.toml` profile files
beside the base Codex configuration. Current Codex uses these overlay files;
legacy `[profiles.<name>]` tables do not select a runtime profile. For CLI use,
select a profile with `codex --profile antigravity_gemini_3_8_flash_high`.
The standalone `app-server` command does not accept that CLI profile flag; its
model catalog carries the same per-model budgets for Desktop selection.
An App Server client can also apply the profile's values explicitly through
`thread/start` or `thread/resume`: select the profile's `model`, pass its
`model_provider` as `modelProvider`, and pass the profile values as `config`.
Profiles select `custom` with the existing authenticated local gateway,
which resolves the namespaced model alias and injects the manager credential.
The request arriving at the manager uses its original model ID and Responses
protocol. Codex's `auth.json` is never read or overwritten by the importer.

This preserves coexistence with Web/native and NVIDIA routes. Unlike clicking
the standalone button, importing does not select one global model or replace
the user's native authentication with the manager key. Global settings, user
profiles and unrelated provider entries are preserved. A conflicting `custom`
provider or unowned profile file fails validation instead of being replaced.

Current manager inventory is listed. Historical aliases remain routable but
are hidden from new selections. New rows reuse existing family metadata; the
sync export does not prove image capabilities or successful generation. The
bridge loads the catalog and routes on each request. The Python gateway must
reload its startup alias configuration after aliases are added. Existing Codex
sessions may require a Desktop restart to refresh their model metadata.

After a manager upgrade, obtain a new handler export in a disposable container,
including current inventory and any historical IDs retained in the catalog.
Do not invoke the sync handler against a production home directory merely to
inspect it: the handler writes that directory's Codex configuration and auth.

## Verification

```sh
bun x --no-install --bun tsc --noEmit
bun test tests/antigravity-codex-sync.test.ts tests/external-routes.test.ts
```

Tests cover the actual exported defaults, catalog hot reload, Responses/auth
semantics, legacy preservation, exact repeated-run idempotence, file backups,
unmodified auth/global settings and refusal to replace conflicting ownership.

Installed-runtime verification on Codex 0.159.2 additionally checked the v2
profile with `debug prompt-input` in a disposable credential-free home and
verified an ephemeral App Server thread with the exact profile overrides.
The installed HTTP catalog returned Gemini's 1024000 window and configured
compaction limit, and the managed App Server listed the model. These checks
invoked no model generations and do not prove a million-token inference works.
