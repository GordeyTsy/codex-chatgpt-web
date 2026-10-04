# Fixed Web context

Set `fixedWebContextWindow` in the bridge's private `config.json` to pin the
canonical history window for every available `chatgpt-web/*` model, including
legacy routes and manual Zero Risk. For example:

```json
{
  "fixedWebContextWindow": 500000
}
```

The model catalog and runtime preflight use the same value. The effective
catalog percentage is 100 and auto-compaction starts at 90% (450000 for the
example). Account tier, reasoning effort and Bigger Context do not multiply or
replace this window. Omit the setting to retain upstream account-derived defaults.

This setting changes the bridge's context policy, not the provider's actual
capacity. Measured per-message token and composer limits remain enforced.
Bigger Context splits automatic requests into bounded messages when enabled;
an individual oversized record still requires compaction. Native OpenAI,
Antigravity and NVIDIA catalog entries are unchanged. Restart the bridge and
Codex Desktop to reload the model metadata.
