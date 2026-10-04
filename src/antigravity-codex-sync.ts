import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

type ObjectValue = Record<string, unknown>;
export interface CodexSyncContract {
  model: string;
  model_provider: string;
  model_context_window: number;
  model_auto_compact_token_limit: number;
  provider: { name: string; wire_api: "responses"; requires_openai_auth: true; base_url: string; model: string };
}
export interface CodexSyncExport {
  version: 1;
  source: { image: string; handler: "POST /api/proxy/cli/sync"; app_type: "Codex" };
  inventory: string[];
  models: CodexSyncContract[];
}
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BEGIN = "# BEGIN Antigravity Codex Sync profiles";
const END = "# END Antigravity Codex Sync profiles";
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Consume actual Codex-button output; no Gemini budget is duplicated here. */
export function parseCodexSyncExport(value: unknown): CodexSyncExport {
  if (!object(value) || value.version !== 1 || !object(value.source)
    || value.source.app_type !== "Codex" || value.source.handler !== "POST /api/proxy/cli/sync"
    || typeof value.source.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.source.image)
    || !Array.isArray(value.inventory) || !value.inventory.length || !Array.isArray(value.models)) {
    throw new Error("Expected an export from Antigravity's actual Codex sync handler");
  }
  if (Object.keys(value).some(key => !["version", "source", "inventory", "models"].includes(key))
    || Object.keys(value.source).some(key => !["image", "handler", "app_type"].includes(key))) {
    throw new Error("Unexpected fields in Codex sync export");
  }
  const inventory = new Set<string>();
  for (const id of value.inventory) {
    if (typeof id !== "string" || !MODEL_ID.test(id) || inventory.has(id)) throw new Error("Invalid manager inventory");
    inventory.add(id);
  }
  const contracts = new Set<string>();
  let providerIdentity: string | undefined;
  for (const entry of value.models) {
    if (!object(entry) || typeof entry.model !== "string" || !MODEL_ID.test(entry.model)
      || contracts.has(entry.model) || entry.model_provider !== "custom"
      || !integer(entry.model_context_window) || !integer(entry.model_auto_compact_token_limit)
      || entry.model_auto_compact_token_limit > entry.model_context_window || !object(entry.provider)) {
      throw new Error("Invalid Codex sync model contract");
    }
    const provider = entry.provider;
    if (provider.wire_api !== "responses" || provider.requires_openai_auth !== true
      || typeof provider.name !== "string" || !provider.name.trim() || provider.model !== entry.model
      || typeof provider.base_url !== "string"
      || Object.keys(provider).some(key => !["name", "wire_api", "requires_openai_auth", "base_url", "model"].includes(key))) {
      throw new Error("Invalid Codex sync provider contract");
    }
    const url = new URL(provider.base_url);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
      throw new Error("The exported Codex probe must use a credential-free loopback endpoint");
    }
    if (Object.keys(entry).some(key => !["model", "model_provider", "model_context_window", "model_auto_compact_token_limit", "provider"].includes(key))) {
      throw new Error("Unexpected fields in Codex sync export");
    }
    const identity = JSON.stringify([provider.name, provider.base_url]);
    if (providerIdentity !== undefined && providerIdentity !== identity) throw new Error("Inconsistent Codex sync provider");
    providerIdentity = identity;
    contracts.add(entry.model);
  }
  if ([...inventory].some(id => !contracts.has(id))) throw new Error("A current manager model lacks its Codex sync contract");
  return structuredClone(value) as unknown as CodexSyncExport;
}

function parseConfig(text: string): ObjectValue {
  const value = getStaticTOMLValue(parseTOML(text, { tomlVersion: "1.0" }));
  if (!object(value)) throw new Error("Invalid Codex config");
  return value;
}
function profileName(model: string): string {
  return `antigravity_${model.replace(/[.-]/g, "_")}`;
}

/** Preserve all global settings/authentication; express sync defaults per model. */
function syncProfiles(text: string, models: ObjectValue[], contracts: Map<string, CodexSyncContract>, baseUrl: string): {
  configText: string; profileConfigs: Record<string, string>;
} {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => line === BEGIN ? [i] : []);
  const ends = lines.flatMap((line, i) => line === END ? [i] : []);
  if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0]! >= ends[0]!)) {
    throw new Error("Ambiguous managed Codex sync profile block");
  }
  if (starts.length) lines.splice(starts[0]!, ends[0]! - starts[0]! + 1);
  const preserved = lines.join(eol).replace(/(?:\r?\n)+$/, "");
  const before = parseConfig(preserved);
  const providers = before.model_providers;
  const custom = object(providers) ? providers.custom : undefined;
  const sample = contracts.values().next().value!;
  if (custom !== undefined && (!object(custom) || custom.base_url !== baseUrl
    || custom.wire_api !== sample.provider.wire_api || custom.requires_openai_auth !== true)) {
    throw new Error("Existing custom provider belongs to a different endpoint; nothing was changed");
  }
  const fragment: string[] = [BEGIN];
  if (custom === undefined) fragment.push("[model_providers.custom]", `name = ${JSON.stringify(sample.provider.name)}`,
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"', "requires_openai_auth = true", "");
  const names = new Set<string>();
  const profileConfigs: Record<string, string> = {};
  for (const row of models) {
    const model = String(row.slug).slice("antigravity/".length);
    const contract = contracts.get(model)!;
    const name = profileName(model);
    if (names.has(name) || (object(before.profiles) && Object.hasOwn(before.profiles, name))) {
      throw new Error("Codex sync profile collides with an existing profile");
    }
    names.add(name);
    // Current Codex layers <name>.config.toml, not legacy [profiles.<name>] tables.
    profileConfigs[`${name}.config.toml`] = [BEGIN, `model = ${JSON.stringify(row.slug)}`,
      `model_provider = ${JSON.stringify(contract.model_provider)}`,
      `model_context_window = ${contract.model_context_window}`,
      `model_auto_compact_token_limit = ${contract.model_auto_compact_token_limit}`, END, ""].join(eol);
  }
  fragment.push(END);
  const result = `${preserved}${preserved ? eol + eol : ""}${fragment.join(eol)}${eol}`;
  parseConfig(result);
  return { configText: result, profileConfigs };
}

export function syncAntigravityCodex(input: {
  exported: CodexSyncExport; catalog: ObjectValue; routes: ObjectValue; gateway: ObjectValue; configText: string;
}): { catalog: ObjectValue & { models: ObjectValue[] }; routes: ObjectValue & { routes: ObjectValue[] };
  gateway: ObjectValue & { aliases: ObjectValue }; configText: string; profileConfigs: Record<string, string>;
  currentModels: number; retainedModels: number } {
  const exported = parseCodexSyncExport(input.exported);
  if (!Array.isArray(input.catalog.models) || !input.catalog.models.every(object)
    || input.routes.version !== 1 || !Array.isArray(input.routes.routes) || !input.routes.routes.every(object)
    || !object(input.gateway.aliases)) throw new Error("Invalid existing multi-provider configuration");
  const catalog = structuredClone(input.catalog) as ObjectValue & { models: ObjectValue[] };
  const rows = catalog.models;
  const routes = structuredClone(input.routes) as ObjectValue & { routes: ObjectValue[] };
  const candidates = routes.routes.filter(route => route.id === "antigravity-manager");
  if (candidates.length !== 1) throw new Error("Expected one registered Antigravity route");
  const route = candidates[0]!;
  if (!Array.isArray(route.modelIds) || route.modelIds.some(id => typeof id !== "string" || !id.startsWith("antigravity/"))) {
    throw new Error("Antigravity route contains foreign model ownership");
  }
  if (typeof route.baseUrl !== "string") throw new Error("Missing existing gateway URL");
  const url = new URL(route.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("Custom provider must use the existing authenticated loopback gateway");
  }
  const gateway = structuredClone(input.gateway) as ObjectValue & { aliases: ObjectValue };
  const aliases = gateway.aliases;
  const contracts = new Map(exported.models.map(contract => [contract.model, contract]));
  const current = new Set(exported.inventory);
  const existingIds = new Set(rows.map(row => row.slug));
  if (existingIds.size !== rows.length) throw new Error("Existing catalog has duplicate model IDs");
  const originals = rows.filter(row => typeof row.slug === "string" && row.slug.startsWith("antigravity/"));
  if (!originals.length) throw new Error("No existing Antigravity catalog template");
  for (const row of originals) {
    const id = String(row.slug).slice("antigravity/".length);
    if (aliases[String(row.slug)] !== id || !contracts.has(id)) throw new Error("Existing model alias lacks an exact Codex contract");
  }
  if ((routes.routes as ObjectValue[]).some(other => other !== route && Array.isArray(other.modelIds)
    && other.modelIds.some(id => typeof id === "string" && id.startsWith("antigravity/")))) {
    throw new Error("Another route owns an Antigravity model");
  }
  let priority = Math.max(...rows.map(row => typeof row.priority === "number" ? row.priority : 0));
  for (const id of exported.inventory) {
    const slug = `antigravity/${id}`;
    if (!existingIds.has(slug)) {
      const family = id.split("-")[0]!;
      const templates = originals.filter(row => String(row.slug).startsWith(`antigravity/${family}-`));
      if (!templates.length) throw new Error("No existing catalog metadata for the new model family");
      const suffix = id.split("-").at(-1)!;
      const template = templates.find(row => String(row.slug).endsWith(`-${suffix}`)) ?? templates[0]!;
      rows.push({ ...structuredClone(template), slug, display_name: `${id} (Antigravity)`, priority: ++priority });
      existingIds.add(slug);
    }
    if (Object.hasOwn(aliases, slug) && aliases[slug] !== id) throw new Error("Existing alias targets a different manager model");
    aliases[slug] = id;
  }
  const managerRows = rows.filter(row => typeof row.slug === "string" && row.slug.startsWith("antigravity/"));
  for (const row of managerRows) {
    const id = String(row.slug).slice("antigravity/".length);
    const contract = contracts.get(id)!;
    row.context_window = contract.model_context_window;
    row.max_context_window = contract.model_context_window;
    row.auto_compact_token_limit = contract.model_auto_compact_token_limit;
    // Codex's default effective percentage applies, just as after button sync.
    delete row.effective_context_window_percent;
    row.prefer_websockets = false;
    row.supported_in_api = true;
    row.visibility = current.has(id) ? "list" : "hide";
  }
  route.modelIds = managerRows.map(row => row.slug);
  const profiles = syncProfiles(input.configText, managerRows, contracts, url.toString().replace(/\/$/, ""));
  return { catalog, routes, gateway, ...profiles, currentModels: current.size, retainedModels: managerRows.length - current.size };
}
