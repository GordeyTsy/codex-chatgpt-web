/** Installed application acceptance. Generation is opt-in and uses only synthetic content. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexHome } from "../src/codex-integration-shared";
import { decodeCompactionSummary } from "../src/responses/compaction";

const args = process.argv.slice(2);
const base = args.find(a => a.startsWith("--base-url="))?.slice(11) ?? "http://127.0.0.1:17841/v1";
const url = new URL(base);
if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
  throw new Error("Smoke requests require an explicit local bridge");
}
const auth = JSON.parse(readFileSync(join(getCodexHome(), "auth.json"), "utf8"));
const token = auth.tokens?.access_token ?? auth.OPENAI_API_KEY;
if (typeof token !== "string" || !token) throw new Error("Codex authentication is unavailable");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const versionProbe = Bun.spawnSync(["codex", "--version"]);
const clientVersion = /\b(\d+\.\d+\.\d+)/.exec(versionProbe.stdout.toString())?.[1];
if (versionProbe.exitCode !== 0 || !clientVersion) throw new Error("Cannot identify the installed Codex CLI version");
const catalogResponse = await fetch(`${base}/models?client_version=${clientVersion}`, { headers, signal: AbortSignal.timeout(60000) });
if (!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}`);
const catalog = await catalogResponse.json() as { models: Array<{ slug: string; context_window?: number; auto_compact_token_limit?: number }> };
console.log(JSON.stringify({ check: "catalog", native: catalog.models.filter(m => !m.slug.includes("/")).length,
  web: catalog.models.filter(m => m.slug.startsWith("chatgpt-web/")).length,
  external: catalog.models.filter(m => m.slug.includes("/") && !m.slug.startsWith("chatgpt-web/")).length }));

async function post(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Application request HTTP ${response.status}`); }
  if (!body.stream) return response.json();
  const text = await response.text();
  const events = text.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
  if (events.some(e => ["error", "response.failed", "response.incomplete"].includes(e.type))) throw new Error("Application stream failed or was incomplete");
  const completed = events.filter(e => e.type === "response.completed");
  if (completed.length !== 1) throw new Error("Expected one terminal completed response");
  return completed[0].response;
}

if (args.includes("--generate")) {
  const models = args.filter(a => a.startsWith("--model=")).map(a => a.slice(8));
  if (!models.length) throw new Error("Provide an explicit --model for generation");
  for (const model of models) {
    const metadata = catalog.models.find(m => m.slug === model);
    if (!metadata) throw new Error("Requested smoke model is absent from the installed catalog");
    const start = Date.now();
    const nonce = crypto.randomUUID();
    const input = [{ role: "user", content: `For this harmless application integration test call report_probe with nonce ${nonce}.` }];
    const tools = [{ type: "function", name: "report_probe", description: "Returns a synthetic test nonce; no side effects.",
      parameters: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false } }];
    const first = await post({ model, input, tools, tool_choice: { type: "function", name: "report_probe" }, stream: true });
    const call = first.output?.find((item: any) => item.type === "function_call" && item.name === "report_probe");
    if (!call?.call_id || JSON.parse(call.arguments).nonce !== nonce) throw new Error("Real tool call was not preserved");
    const second = await post({ model, stream: true, tools, tool_choice: "none", input: [...input,
      ...first.output.filter((i: any) => i.type !== "reasoning"), { type: "function_call_output", call_id: call.call_id, output: "Synthetic probe succeeded. Confirm in one short sentence." }] });
    if (second.status !== "completed" || !second.output?.some((i: any) => i.type === "message" && i.content?.some((p: any) => p.type === "output_text" && p.text?.trim()))) {
      throw new Error("Tool-result continuation did not produce a completed answer");
    }
    const compact = await post({ model, stream: true, input: [{ role: "user", content: "Synthetic project: function add(a,b) is implemented. Remaining work: test negative integers. Preserve this state." }, { type: "compaction_trigger" }] });
    if (compact.output?.length !== 1 || compact.output[0].type !== "compaction" || !decodeCompactionSummary(compact.output[0].encrypted_content)?.trim()) {
      throw new Error("Real compaction did not produce a usable checkpoint");
    }
    console.log(JSON.stringify({ check: "application", model, streaming: true, tool_call: true, tool_result: true,
      compaction: true, context_window: metadata.context_window, auto_compact_token_limit: metadata.auto_compact_token_limit,
      elapsed_ms: Date.now() - start, usage_reported: first.usage != null && second.usage != null }));
  }
}
