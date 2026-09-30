import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { appendExternalModels, externalResponseRequest, loadExternalRoutes } from "../src/external-routes";
import { modelsRequest, responseRequest, compactRequest } from "../src/server";
import { decodeCompactionSummary, encodeCompactionSummary } from "../src/responses/compaction";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const glm = "z-ai/glm-test";
const gemini = "antigravity/gemini-test";
const row = (slug: string) => ({ slug, display_name: slug, visibility: "list", context_window: 300000,
  max_context_window: 300000, auto_compact_token_limit: 270000, supported_reasoning_levels: [{ effort: "high" }],
  default_reasoning_level: "high", tool_mode: null, multi_agent_version: null });
function fixture(url = "http://127.0.0.1:17843/v1") {
  const home = mkdtempSync(join(tmpdir(), "external-routes-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig("full");
  config.externalRoutesPath = join(home, "routes.json");
  const catalogPath = join(home, "catalog.json");
  const document = { version: 1, routes: [{ id: "test", baseUrl: url, catalogPath, modelIds: [glm, gemini] }] };
  const save = () => writeFileSync(config.externalRoutesPath!, JSON.stringify(document));
  writeFileSync(catalogPath, JSON.stringify({ models: [row(glm), row(gemini), row("gpt-native")] }));
  save();
  return { config, document, save, catalogPath };
}
function request(body: unknown, signal?: AbortSignal) {
  return new Request("http://127.0.0.1/v1/responses", { method: "POST", signal,
    headers: { authorization: "Bearer fixture", "content-type": "application/json", cookie: "do-not-forward", "chatgpt-account-id": "private" },
    body: JSON.stringify(body) });
}
function summaryResponse(status = "completed", output?: unknown[]) {
  return Response.json({ id: "resp_fixture", object: "response", created_at: 1, status, model: glm, error: null,
    output: output ?? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Keep the implemented feature; run remaining tests." }] }],
    usage: { input_tokens: 123, output_tokens: 12, total_tokens: 135 } });
}

test("merges all sources without overriding native/Web rows or external budgets", async () => {
  const { config } = fixture();
  const result = await modelsRequest(request({}), config, async () => Response.json({ models: [{
    ...row("gpt-native"), tool_mode: "code_mode_only", context_window: 1000000,
  }] }));
  const body = await result.json();
  expect(result.status).toBe(200);
  expect(body.models.some((m: any) => m.slug.startsWith("chatgpt-web/"))).toBeTrue();
  expect(body.models.find((m: any) => m.slug === glm)).toMatchObject({ context_window: 300000, auto_compact_token_limit: 270000, prefer_websockets: false });
  expect(body.models.filter((m: any) => m.slug === "gpt-native")).toHaveLength(1);
  expect(body.models.find((m: any) => m.slug === "gpt-native").context_window).toBe(1000000);
  expect(() => appendExternalModels({ models: [row(glm)] }, config)).toThrow("collides");
});

test("validates loopback destinations, inventories and duplicate ownership", () => {
  for (const url of ["https://elsewhere.example/v1", "http://localhost/v1", "http://127.0.0.1:17841/v1", "http://a:b@127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1?secret=value"]) {
    expect(() => loadExternalRoutes(fixture(url).config)).toThrow("configuration");
  }
  const { config, document, save, catalogPath } = fixture();
  document.routes[0]!.modelIds.push(glm); save();
  expect(() => loadExternalRoutes(config)).toThrow();
  document.routes[0]!.modelIds = ["chatgpt-web/gpt-6-pro"]; save();
  expect(() => loadExternalRoutes(config)).toThrow();
  document.routes[0]!.modelIds = ["gpt-native"]; save();
  expect(() => loadExternalRoutes(config)).toThrow();
  document.routes[0]!.modelIds = [glm]; save();
  writeFileSync(catalogPath, "{private-broken-document");
  expect(() => loadExternalRoutes(config)).toThrow("External routes configuration is invalid or unavailable");
});

test("exact external routing preserves SSE tools, usage and errors without native cookies", async () => {
  const { config } = fixture();
  for (const model of [glm, gemini]) {
    const body = { model, stream: true, input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
      tools: [{ type: "namespace", name: "tools", tools: [{ type: "function", name: "inspect", parameters: {} }] }] };
    const payload = 'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_2","namespace":"tools","name":"inspect"}}\n\ndata: {"type":"response.incomplete","response":{"usage":null}}\n\n';
    const result = await externalResponseRequest(request(body), config, body, false, async req => {
      expect(req.url).toBe("http://127.0.0.1:17843/v1/responses");
      expect(req.redirect).toBe("manual");
      expect(req.headers.get("authorization")).toBe("Bearer fixture");
      expect(req.headers.get("cookie")).toBeNull();
      expect(req.headers.get("chatgpt-account-id")).toBeNull();
      expect(await req.json()).toEqual(body);
      return new Response(payload, { headers: { "content-type": "text/event-stream", "set-cookie": "private" } });
    });
    expect(await result!.text()).toBe(payload);
    expect(result!.headers.get("set-cookie")).toBeNull();
  }
});

test("native and Web routes stay untouched; unconfigured external model never falls back", async () => {
  const { config } = fixture();
  const unexpected = async () => { throw new Error("Must not fetch"); };
  for (const model of ["gpt-6-astra", "chatgpt-web/gpt-6-pro"]) {
    expect(await externalResponseRequest(request({ model }), config, { model }, false, unexpected)).toBeNull();
  }
  expect((await responseRequest(request({ model: "antigravity/unknown" }), config)).status).toBe(404);
  expect((await compactRequest(request({ model: "z-ai/unknown" }), config)).status).toBe(404);
  expect((await externalResponseRequest(new Request("http://localhost"), config, { model: glm }, false, unexpected))!.status).toBe(401);
});

test("preserves upstream 429 and refuses redirects and network fallback", async () => {
  const { config } = fixture();
  const body = { model: glm, input: "test" };
  const result = await externalResponseRequest(request(body), config, body, false, async () => new Response("quota", { status: 429, headers: { "retry-after": "9" } }));
  expect(result!.status).toBe(429);
  expect(result!.headers.get("retry-after")).toBe("9");
  expect(await result!.text()).toBe("quota");
  expect((await externalResponseRequest(request(body), config, body, false, async () => Response.redirect("https://example.com")))!.status).toBe(502);
  const failed = await externalResponseRequest(request(body), config, body, false, async () => { throw new Error("private-key"); });
  expect(await failed!.text()).not.toContain("private-key");
});

test("remote compaction uses the same external model and real summary for unary and SSE", async () => {
  const { config } = fixture();
  for (const stream of [false, true]) {
    const body = { model: gemini, reasoning: { effort: "high" }, instructions: "Preserve original constraints", stream,
      tools: [{ type: "function", name: "never_execute" }], input: [{ role: "user", content: "existing work" }, { type: "compaction_trigger" }] };
    const result = await externalResponseRequest(request(body), config, body, false, async req => {
      const payload = await req.json();
      expect(payload.model).toBe(gemini);
      expect(payload.reasoning).toEqual(body.reasoning);
      expect(payload.instructions).toBe(body.instructions);
      expect(payload.tools).toBeUndefined();
      expect(payload.stream).toBeFalse();
      expect(payload.input[0]).toEqual(body.input[0]);
      expect(payload.input.some((i: any) => i.type === "compaction_trigger")).toBeFalse();
      return summaryResponse();
    });
    const text = await result!.text();
    const response = stream ? JSON.parse(text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).find(l => JSON.parse(l).type === "response.completed")!).response : JSON.parse(text);
    expect(response.model).toBe(gemini);
    expect(response.output).toHaveLength(1);
    expect(decodeCompactionSummary(response.output[0].encrypted_content)).toContain("remaining tests");
    expect(response.usage.total_tokens).toBe(135);
  }
});

test("legacy compact retains user messages; v2 checkpoint replays as plain history", async () => {
  const { config } = fixture();
  const body = { model: glm, input: [{ role: "user", content: "Original task" }] };
  const legacy = await externalResponseRequest(request(body), config, body, true, async () => summaryResponse());
  expect((await legacy!.json()).output[0].content[0].text).toBe("Original task");
  const continuation = { model: glm, input: [{ type: "compaction", encrypted_content: encodeCompactionSummary("Saved progress") },
    { type: "reasoning", encrypted_content: "provider-private" }, { id: "msg_private", role: "user", content: "Continue" }] };
  await externalResponseRequest(request(continuation), config, continuation, false, async req => {
    const input = (await req.json()).input;
    expect(input).toHaveLength(2);
    expect(input[0].content[0].text).toContain("Saved progress");
    expect(input[1].id).toBeUndefined();
    return summaryResponse();
  });
});

test("never installs incomplete, refused, empty or opaque compaction as successful history", async () => {
  const { config } = fixture();
  const body = { model: glm, input: [{ type: "compaction_trigger" }] };
  for (const response of [summaryResponse("incomplete"), summaryResponse("completed", []),
    summaryResponse("completed", [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] }])]) {
    expect((await externalResponseRequest(request(body), config, body, false, async () => response))!.status).toBe(502);
  }
  const opaque = { model: glm, input: [{ type: "compaction", encrypted_content: "opaque" }] };
  let calls = 0;
  expect((await externalResponseRequest(request(opaque), config, opaque, false, async () => { calls++; return summaryResponse(); }))!.status).toBe(502);
  expect(calls).toBe(0);
});

test("cancelled compaction aborts upstream and does not emit completion", async () => {
  const { config } = fixture();
  const body = { model: glm, stream: true, input: [{ type: "compaction_trigger" }] };
  let aborted = false;
  const result = await externalResponseRequest(request(body), config, body, false, async req => new Promise<Response>((_resolve, reject) => {
    req.signal.addEventListener("abort", () => { aborted = true; reject(req.signal.reason); }, { once: true });
  }));
  await result!.body!.cancel();
  await Bun.sleep(5);
  expect(aborted).toBeTrue();
});

test("real local HTTP handler routes compressed requests, preserves tool output and observes cancellation", async () => {
  let received: any;
  let stopped = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    received = await req.json();
    req.signal.addEventListener("abort", () => { stopped = true; });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": pending\n\n")); } }),
      { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(() => server.stop(true));
  const { config } = fixture(`http://127.0.0.1:${server.port}/v1`);
  const body = { model: glm, stream: true, input: [{ type: "function_call_output", call_id: "abc", output: "test" }] };
  const abort = new AbortController();
  const req = new Request("http://127.0.0.1/v1/responses", { method: "POST", signal: abort.signal,
    headers: { authorization: "Bearer fixture", "content-encoding": "zstd" }, body: new Uint8Array(await Bun.zstdCompress(JSON.stringify(body))) });
  const response = await responseRequest(req, config);
  expect(response.status).toBe(200);
  expect(received).toEqual(body);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBeFalse();
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !stopped; i++) await Bun.sleep(10);
  expect(stopped).toBeTrue();
});
