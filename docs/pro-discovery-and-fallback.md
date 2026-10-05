# Pro discovery and explicit quota fallback

The Web catalog separates account entitlement (`proAvailable`) from a verified
picker failure (`proSelectable: false`). A temporary Pro quota must not turn a
Pro subscription into a Plus account or permanently delete its model metadata.
An unavailable row stays hidden so an existing task retains its routing identity.

The production Launcher checks the actual authenticated picker at startup and
then hourly. Active turns, pending browser operations, authentication failures
and network errors defer the check without changing the catalog. The checker
never sends a prompt, calls a model, or navigates an active task tab. Positive
Pro picker evidence updates the running bridge and private configuration through
its authenticated control endpoint; no daemon restart is necessary. A negative
periodic observation does not hide anything. Only an actual Pro selection failure
with an explicit unavailable/locked/quota result hides the row. Unknown selector,
transport and protocol failures are not availability evidence.

`proQuotaFallbackThreadIds` is an optional bounded list of native thread UUIDs.
Only these tasks, requesting GPT-6 Pro, may switch to GPT-5.6 Sol Extra High on
the explicit `chatgpt_pro_quota_exhausted` result from the picker explanation.
An ordinary rate limit, authentication failure, access restriction, or unknown
model failure never selects another model. The same logical turn and tool binding
survive the fallback; already completed tool effects are retained. New context is
compiled for Sol and multipart staging avoids exhausted Pro. The switch is
reported in task commentary. Other chats keep strict requested-model behavior.
The next logical turn can try Pro again; this is not an account or quota bypass.
