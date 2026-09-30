# Local external model routes (fork extension)

The fork can expose native Codex, ChatGPT Web, and explicitly configured external
models in the same `/v1/models` catalog. Native and Web execution are unchanged.
External requests go to an existing trusted loopback Responses gateway, which owns
provider authentication, balancing, quotas, tool conversion and retries. This
extension does not select a replacement model or switch providers after failure.

Set `externalRoutesPath` in the private application `config.json` to an absolute
path to a file with this structure (example paths only):

```json
{
  "version": 1,
  "routes": [{
    "id": "local-gateway",
    "baseUrl": "http://127.0.0.1:17843/v1",
    "catalogPath": "/absolute/private/model-catalog.json",
    "modelIds": ["vendor/model-id", "manager/model-id"]
  }]
}
```

The catalog uses Codex's `{"models": [...]}` format. Only the exact selected IDs
are imported. Context limits, reasoning levels and capabilities come from these
rows; they are not inherited from an unrelated native model. Generate `modelIds`
from the gateway's actual inventory. IDs must be namespaced, unique, and outside
`chatgpt-web/`. Catalog collisions and missing rows fail closed. Both files are
reloaded on requests; changing the application path requires restarting the bridge.
Keep configuration private and outside Git. Do not put API keys in these files.

Only numeric loopback HTTP addresses with `/v1` are accepted. The trusted gateway
must validate incoming Codex bearer authentication and replace it with its own
provider credentials before contacting an external service. Native cookies and
account headers are not forwarded. Redirects are rejected. Never point a route
back to this bridge. Removing a route never sends its namespaced model to OpenAI.

Use the bridge's normal built-in Codex integration (`openai_base_url`). Do not
select the old gateway provider or static catalog in Codex at the same time.
Existing MCP configuration and native authentication remain intact. Restart Codex
Desktop to refresh its model catalog after installation.

The built-in OpenAI provider can request remote compaction for external models.
Both `/responses/compact` and the streaming v2 `compaction_trigger` are handled by
calling the **same selected external model** as a summarizer, with tools disabled.
Only a completed, nonempty textual summary becomes replacement history; errors,
refusals and truncation never become successful checkpoints. Checkpoints use the
existing bridge `ocx1:` envelope, decoded before replay. Opaque foreign checkpoints
and backend-local response references are rejected instead of silently losing
history. Cancellation propagates to the gateway. Ordinary streams pass through
without rewriting tool calls, usage, failure or refusal events.

Validation: `bun test tests/external-routes.test.ts`, `bun run typecheck`, then the
normal AppImage build and installed smoke tests. Test fixtures are isolated local
servers; live acceptance must separately verify the installed catalog and each
configured gateway with harmless application requests.
