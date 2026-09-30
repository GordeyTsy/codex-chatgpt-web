import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AppConfig } from "./config";
import { expandUserPath } from "./config";
import { formatErrorResponse } from "./bridge";
import {
  buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary,
  encodeCompactionSummary, extractCompactUserMessages, SUMMARY_PREFIX,
} from "./responses/compaction";

type Json = Record<string, unknown>;
interface Route { id: string; baseUrl: string; models: Json[] }
type Fetch = (request: Request) => Promise<Response>;

function object(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readObject(path: string): Json {
  if (!isAbsolute(expandUserPath(path))) throw new Error("External route files must use absolute paths");
  const value: unknown = JSON.parse(readFileSync(expandUserPath(path), "utf8"));
  if (!object(value)) throw new Error("Invalid external route document");
  return value;
}

/** Reload inventories for each request. Never infer routes from native model metadata. */
export function loadExternalRoutes(config: AppConfig): Route[] {
  if (!config.externalRoutesPath) return [];
  try {
    const document = readObject(config.externalRoutesPath);
    if (document.version !== 1 || !Array.isArray(document.routes)) throw new Error();
    const ids = new Set<string>();
    const slugs = new Set<string>();
    return document.routes.map(value => {
      if (!object(value) || typeof value.id !== "string" || !/^[a-z0-9-]+$/.test(value.id)
        || ids.has(value.id) || typeof value.baseUrl !== "string" || typeof value.catalogPath !== "string"
        || !Array.isArray(value.modelIds) || !value.modelIds.length) throw new Error();
      ids.add(value.id);
      const url = new URL(value.baseUrl);
      // These are trusted local adapters, never arbitrary destinations for Codex credentials.
      if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1"
        || Number(url.port || 80) === config.port) throw new Error();
      const catalog = readObject(value.catalogPath);
      if (!Array.isArray(catalog.models)) throw new Error();
      const models = value.modelIds.map(slug => {
        if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(slug)
          || slug.startsWith("chatgpt-web/") || slugs.has(slug)) throw new Error();
        slugs.add(slug);
        const matches = (catalog.models as unknown[]).filter(m => object(m) && m.slug === slug);
        if (matches.length !== 1) throw new Error();
        const model = matches[0] as Json;
        if (typeof model.display_name !== "string" || !Array.isArray(model.supported_reasoning_levels)
          || !Number.isSafeInteger(model.context_window) || Number(model.context_window) <= 0
          || (model.auto_compact_token_limit != null && (!Number.isSafeInteger(model.auto_compact_token_limit)
            || Number(model.auto_compact_token_limit) <= 0 || Number(model.auto_compact_token_limit) > Number(model.context_window)))) throw new Error();
        return structuredClone(model);
      });
      return { id: value.id, baseUrl: url.toString().replace(/\/$/, ""), models };
    });
  } catch {
    // Parser errors can contain private catalog contents or local filesystem paths.
    throw new Error("External routes configuration is invalid or unavailable; check the local route and catalog files");
  }
}

export function appendExternalModels(catalog: Json, config: AppConfig): Json {
  const models = Array.isArray(catalog.models) ? [...catalog.models] : [];
  const existing = new Set(models.filter(object).map(m => m.slug));
  for (const route of loadExternalRoutes(config)) {
    for (const model of route.models) {
      if (existing.has(model.slug)) throw new Error("External model collides with an existing catalog entry");
      existing.add(model.slug);
      models.push({ ...model, prefer_websockets: false });
    }
  }
  return { ...catalog, models };
}

/** Only bridge checkpoints are portable. Opaque checkpoints must not silently lose history. */
function portableBody(raw: Json): Json {
  if (raw.previous_response_id || raw.conversation) {
    throw new Error("External models require complete input history, not a backend-local response reference");
  }
  if (!Array.isArray(raw.input)) return { ...raw };
  const input = raw.input.flatMap(item => {
    if (!object(item)) return [item];
    if (item.type === "compaction") {
      const summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
      if (!summary?.trim()) throw new Error("This checkpoint cannot be read by the selected external model; resume with its original provider");
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }];
    }
    // Reasoning signatures and item IDs belong to the generating provider. User messages and
    // complete tool calls/results remain unchanged, including call_id and namespaces.
    if (item.type === "reasoning") return [];
    const clean = { ...item };
    delete clean.id;
    return [clean];
  });
  return { ...raw, input };
}

async function forward(req: Request, route: Route, body: Json, fetchUpstream: Fetch, signal: AbortSignal): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" });
  // Only the explicitly trusted loopback gateway receives the bearer; it validates Codex auth
  // and substitutes its own provider key. Account cookies and native headers are never forwarded.
  headers.set("authorization", req.headers.get("authorization")!);
  const response = await fetchUpstream(new Request(`${route.baseUrl}/responses`, {
    method: "POST", headers, body: JSON.stringify(body), signal, redirect: "manual",
  }));
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return formatErrorResponse(502, "upstream_error", "External gateway redirects are not permitted");
  }
  const outgoing = new Headers();
  for (const key of ["content-type", "retry-after", "x-request-id"]) {
    const value = response.headers.get(key);
    if (value) outgoing.set(key, value);
  }
  outgoing.set("cache-control", "no-store");
  // Streaming stays byte-for-byte: tool events, usage (including null), refusal and incomplete
  // statuses belong to the gateway. Cancelling this body cancels its upstream reader.
  return new Response(response.body, { status: response.status, headers: outgoing });
}

function summaryBody(raw: Json): Json {
  const body = portableBody(raw);
  const input = Array.isArray(body.input) ? body.input.filter(item => !object(item) || item.type !== "compaction_trigger")
    : typeof body.input === "string" ? [{ role: "user", content: body.input }] : [];
  // A checkpoint is a dedicated model call without executable tools. Preserve the same model,
  // effort, original instructions and history; do not invent a replacement summary locally.
  body.input = [...input, { role: "user", content: COMPACT_PROMPT }];
  body.stream = false;
  for (const key of ["tools", "tool_choice", "parallel_tool_calls", "client_metadata", "text", "include"]) delete body[key];
  return body;
}

function completedSummary(value: unknown): { summary: string; response: Json } {
  if (!object(value) || value.status !== "completed" || value.error || !Array.isArray(value.output)) {
    throw new Error("External compaction did not complete; original history must be retained");
  }
  const parts: string[] = [];
  for (const item of value.output) {
    if (!object(item)) throw new Error("Invalid external compaction output");
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new Error("External compaction returned non-summary output");
    }
    for (const part of item.content) {
      if (!object(part) || part.type !== "output_text" || typeof part.text !== "string") {
        throw new Error("External compaction returned non-text output");
      }
      parts.push(part.text);
    }
  }
  const summary = parts.join("\n").trim();
  if (!summary) throw new Error("External compaction returned an empty summary");
  return { summary, response: value };
}

async function compact(req: Request, route: Route, raw: Json, legacy: boolean, fetchUpstream: Fetch): Promise<Response> {
  const body = summaryBody(raw);
  const controller = new AbortController();
  const signal = AbortSignal.any([req.signal, controller.signal]);
  const generate = async () => {
    const response = await forward(req, route, body, fetchUpstream, signal);
    if (!response.ok) return { error: response };
    const result = completedSummary(await response.json());
    return { value: legacy
      ? { output: buildCompactV1Output(extractCompactUserMessages(raw.input), result.summary), usage: result.response.usage ?? null }
      : { ...result.response, model: raw.model, output: [{ type: "compaction", id: `cmp_${crypto.randomUUID().replaceAll("-", "")}`,
        encrypted_content: encodeCompactionSummary(result.summary) }] } };
  };
  if (legacy || raw.stream !== true) {
    const result = await generate();
    return result.error ?? Response.json(result.value);
  }
  let heartbeat: ReturnType<typeof setInterval>;
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const emit = (type: string, payload: Json) => {
        if (!cancelled) output.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
      };
      heartbeat = setInterval(() => { if (!cancelled) output.enqueue(encoder.encode(": compacting\n\n")); }, 2000);
      void (async () => {
        try {
          const result = await generate();
          if (result.error) {
            await result.error.body?.cancel();
            emit("error", { error: { type: "upstream_error", code: `external_http_${result.error.status}`,
              message: "External compaction failed; original history must be retained" } });
          } else {
            const response = result.value!;
            const item = response.output[0];
            emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
            emit("response.output_item.done", { output_index: 0, item });
            emit("response.completed", { response });
          }
        } catch {
          emit("error", { error: { type: "upstream_error", message: "External compaction failed; original history must be retained" } });
        } finally {
          clearInterval(heartbeat);
          if (!cancelled) output.close();
        }
      })();
    },
    cancel() { cancelled = true; clearInterval(heartbeat); controller.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

/** null means a native/Web route. Unknown namespaced selections never reach official Codex. */
export async function externalResponseRequest(
  req: Request, config: AppConfig, raw: unknown, legacyCompact = false,
  fetchUpstream: Fetch = request => fetch(request),
): Promise<Response | null> {
  if (!object(raw) || typeof raw.model !== "string" || raw.model.startsWith("chatgpt-web/")) return null;
  try {
    const route = loadExternalRoutes(config).find(r => r.models.some(m => m.slug === raw.model));
    if (!route) return raw.model.includes("/")
      ? formatErrorResponse(404, "invalid_request_error", "No external route is configured for the selected model") : null;
    if (!/^Bearer \S+$/i.test(req.headers.get("authorization") ?? "")) {
      return formatErrorResponse(401, "authentication_error", "Codex bearer authentication is required");
    }
    const trigger = Array.isArray(raw.input) && raw.input.some(item => object(item) && item.type === "compaction_trigger");
    if (trigger || legacyCompact) return await compact(req, route, raw, legacyCompact, fetchUpstream);
    return await forward(req, route, portableBody(raw), fetchUpstream, req.signal);
  } catch (error) {
    if (req.signal.aborted) throw error;
    return formatErrorResponse(502, "upstream_error", "External route failed; check its configuration and gateway health. No alternate provider was used.");
  }
}
