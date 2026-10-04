import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { parseCodexSyncExport, syncAntigravityCodex, type CodexSyncExport } from "../src/antigravity-codex-sync";
import { defaultConfig } from "../src/config";
import { loadExternalRoutes } from "../src/external-routes";

const gemini = "gemini-3.8-flash-high";
const claude = "claude-sonnet-4-6";
const gpt = "gpt-oss-120b-medium";
const legacy = "gemini-2.5-flash";
const added = "gemini-3.8-flash-medium";
const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const model = (id: string, budget: number) => ({ model: id, model_provider: "custom",
    model_context_window: budget, model_auto_compact_token_limit: budget,
    provider: { name: "Custom Node", wire_api: "responses" as const, requires_openai_auth: true as const,
      base_url: "http://127.0.0.1:8045/v1", model: id } });
  const exported: CodexSyncExport = { version: 1,
    source: { image: `sha256:${"a".repeat(64)}`, handler: "POST /api/proxy/cli/sync", app_type: "Codex" },
    inventory: [gemini, claude, gpt, added],
    models: [model(gemini, 1_024_000), model(claude, 256_000), model(gpt, 128_000), model(legacy, 1_024_000), model(added, 1_024_000)] };
  const row = (slug: string) => ({ slug, display_name: slug, priority: 10, visibility: "list",
    context_window: 300000, max_context_window: 300000, auto_compact_token_limit: 270000,
    effective_context_window_percent: 100, default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }],
    tool_mode: null, multi_agent_version: null, input_modalities: ["text"], base_instructions: "Preserve existing instructions" });
  return { exported,
    catalog: { models: [row("gpt-native"), row("chatgpt-web/gpt-6-pro"), row("z-ai/glm-5.3"),
      ...[gemini, claude, gpt, legacy].map(id => row(`antigravity/${id}`))] },
    routes: { version: 1, routes: [
      { id: "nvidia-balancer", baseUrl: "http://127.0.0.1:17843/v1", catalogPath: "/private/catalog.json", modelIds: ["z-ai/glm-5.3"] },
      { id: "antigravity-manager", baseUrl: "http://127.0.0.1:17843/v1", catalogPath: "/private/catalog.json",
        modelIds: [gemini, claude, gpt, legacy].map(id => `antigravity/${id}`) }] },
    gateway: { base_url: "http://manager.local:8045", api_key_file: "/private/key-file",
      aliases: Object.fromEntries([gemini, claude, gpt, legacy].map(id => [`antigravity/${id}`, id])) },
    configText: '# Preserve user comments\nmodel = "z-ai/glm-5.3"\nmodel_reasoning_effort = "max"\n'
      + 'openai_base_url = "http://127.0.0.1:17841/v1"\n[mcp_servers.local]\ncommand = "local-server"\n'
      + '[profiles.user_profile]\nmodel = "chatgpt-web/gpt-6-pro"\n' };
}
const toml = (text: string) => getStaticTOMLValue(parseTOML(text)) as any;

test("imports exact Codex-button budgets and Responses/auth semantics without changing other providers", () => {
  const input = fixture();
  const frozen = structuredClone(input);
  const result = syncAntigravityCodex(input);
  expect(input).toEqual(frozen);
  expect(result.catalog.models.slice(0, 3)).toEqual(input.catalog.models.slice(0, 3));
  expect(result.routes.routes[0]).toEqual(input.routes.routes[0]);
  expect(result.gateway.base_url).toBe(input.gateway.base_url);
  expect(result.gateway.api_key_file).toBe(input.gateway.api_key_file);
  const config = toml(result.configText);
  const original = toml(input.configText);
  for (const key of ["model", "model_reasoning_effort", "openai_base_url", "mcp_servers"]) expect(config[key]).toEqual(original[key]);
  expect(config.profiles.user_profile).toEqual(original.profiles.user_profile);
  expect(result.configText).toStartWith(input.configText.trimEnd());
  expect(config.model_providers.custom).toEqual({ name: "Custom Node", wire_api: "responses",
    requires_openai_auth: true, base_url: input.routes.routes[1]!.baseUrl });
  for (const contract of input.exported.models) {
    const row = result.catalog.models.find((row: any) => row.slug === `antigravity/${contract.model}`)!;
    expect(row.context_window).toBe(contract.model_context_window);
    expect(row.max_context_window).toBe(contract.model_context_window);
    expect(row.auto_compact_token_limit).toBe(contract.model_auto_compact_token_limit);
    expect(row.effective_context_window_percent).toBeUndefined();
    const profile = toml(result.profileConfigs[`antigravity_${contract.model.replace(/[.-]/g, "_")}.config.toml`]!);
    expect(profile).toEqual({ model: row.slug, model_provider: contract.model_provider,
      model_context_window: contract.model_context_window, model_auto_compact_token_limit: contract.model_auto_compact_token_limit });
  }
});

test("registers current inventory, keeps historical aliases hidden and is idempotent", () => {
  const input = fixture();
  const result = syncAntigravityCodex(input);
  expect(result.currentModels).toBe(4);
  expect(result.retainedModels).toBe(1);
  expect(result.gateway.aliases[`antigravity/${added}`]).toBe(added);
  expect(result.gateway.aliases[`antigravity/${legacy}`]).toBe(legacy);
  expect(result.catalog.models.find(row => row.slug === `antigravity/${legacy}`)!.visibility).toBe("hide");
  expect(result.catalog.models.find(row => row.slug === `antigravity/${added}`)!.visibility).toBe("list");
  expect(syncAntigravityCodex({ ...result, exported: input.exported })).toEqual(result);
});

test("consumes exported values rather than a second hardcoded budget table", () => {
  const input = fixture();
  input.exported.models[0]!.model_context_window = 777777;
  input.exported.models[0]!.model_auto_compact_token_limit = 700000;
  const result = syncAntigravityCodex(input);
  const row = result.catalog.models.find(row => row.slug === `antigravity/${gemini}`)!;
  expect(row.context_window).toBe(777777);
  expect(row.auto_compact_token_limit).toBe(700000);
});

test("matches the real isolated manager 4.9.1 Codex handler export for every current model", () => {
  const exported = parseCodexSyncExport(JSON.parse(readFileSync(
    resolve("tests/fixtures/antigravity-codex-sync-4.9.1.json"), "utf8")));
  const input = fixture();
  const result = syncAntigravityCodex({ ...input, exported });
  const config = toml(result.configText);
  expect(result.currentModels).toBe(28);
  for (const id of exported.inventory) {
    const contract = exported.models.find(entry => entry.model === id)!;
    const row = result.catalog.models.find(entry => entry.slug === `antigravity/${id}`)!;
    const profile = toml(result.profileConfigs[`antigravity_${id.replace(/[.-]/g, "_")}.config.toml`]!);
    expect([row.context_window, row.auto_compact_token_limit])
      .toEqual([contract.model_context_window, contract.model_auto_compact_token_limit]);
    expect([profile.model_context_window, profile.model_auto_compact_token_limit, profile.model_provider])
      .toEqual([contract.model_context_window, contract.model_auto_compact_token_limit, contract.model_provider]);
  }
  expect(result.catalog.models.find(row => row.slug === `antigravity/${gemini}`)!.context_window).toBe(1_024_000);
});

test("rejects ambiguous, missing, credential-bearing or foreign-client contracts", () => {
  const mutations = [
    (v: any) => { v.source.app_type = "JeikCode"; },
    (v: any) => { v.models[0].model_context_window = 0; },
    (v: any) => { v.models[0].model_auto_compact_token_limit = 2000000; },
    (v: any) => { v.models[0].provider.wire_api = "chat"; },
    (v: any) => { v.models[0].provider.requires_openai_auth = false; },
    (v: any) => { v.models[0].provider.base_url = "http://user:password@127.0.0.1/v1"; },
    (v: any) => { v.models[0].provider.api_key = "test-only-secret"; },
    (v: any) => { v.source.api_key = "test-only-secret"; },
    (v: any) => { v.models.pop(); },
    (v: any) => { v.models.push(v.models[0]); },
    (v: any) => { v.inventory.push(v.inventory[0]); },
    (v: any) => { v.models[0].provider.name = "Different provider"; },
  ];
  for (const mutate of mutations) {
    const exported = fixture().exported;
    mutate(exported);
    expect(() => parseCodexSyncExport(exported)).toThrow();
  }
});

test("refuses to overwrite unrelated custom providers, profiles or route ownership", () => {
  const input = fixture();
  for (const suffix of ['\n[model_providers.custom]\nbase_url="http://127.0.0.1:9000/v1"\n',
    '\n[profiles.antigravity_gemini_3_8_flash_high]\nmodel="user-selected"\n',
    '\n# BEGIN Antigravity Codex Sync profiles\n']) {
    expect(() => syncAntigravityCodex({ ...input, configText: input.configText + suffix })).toThrow();
  }
  input.routes.routes[1]!.modelIds.push("z-ai/glm-5.3");
  expect(() => syncAntigravityCodex(input)).toThrow("foreign model");
  const other = fixture();
  other.routes.routes[0]!.modelIds.push(`antigravity/${gemini}`);
  expect(() => syncAntigravityCodex(other)).toThrow("Another route");
});

test("real file CLI validates first, backs up privately, hot-loads the catalog and leaves auth untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-sync-")); cleanup.push(home);
  const input = fixture();
  const catalog = join(home, "catalog.json");
  for (const route of input.routes.routes) route.catalogPath = catalog;
  const files = { contracts: input.exported, catalog: input.catalog, routes: input.routes, gateway: input.gateway };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(home, `${name}.json`), JSON.stringify(data));
  writeFileSync(join(home, "config.toml"), input.configText);
  const auth = '{"tokens":{"test-only":"do not modify"}}';
  writeFileSync(join(home, "auth.json"), auth);
  const args = [process.execPath, resolve("scripts/sync-antigravity-codex.ts"),
    ...Object.keys(files).flatMap(name => [`--${name}`, join(home, `${name}.json`)]), "--config", join(home, "config.toml")];
  const run = (extra: string[] = []) => Bun.spawnSync([...args, ...extra], { stdout: "pipe", stderr: "pipe" });
  const before = readFileSync(catalog, "utf8");
  const preview = run();
  expect(preview.exitCode).toBe(0);
  expect(readFileSync(catalog, "utf8")).toBe(before);
  expect(JSON.parse(preview.stdout.toString()).applied).toBeFalse();
  const applied = run(["--apply", "--backup-dir", join(home, "backup")]);
  expect(applied.stderr.toString()).toBe("");
  expect(applied.exitCode).toBe(0);
  expect(statSync(join(home, "backup")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "backup", "config.before")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(home, "backup", "catalog.before"), "utf8")).toBe(before);
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(auth);
  expect(toml(readFileSync(join(home, "antigravity_gemini_3_8_flash_high.config.toml"), "utf8")))
    .toMatchObject({ model_provider: "custom", model_context_window: 1_024_000, model_auto_compact_token_limit: 1_024_000 });
  const config = defaultConfig("full"); config.externalRoutesPath = join(home, "routes.json");
  const manager = loadExternalRoutes(config).find(route => route.id === "antigravity-manager")!;
  expect(manager.models.find(row => row.slug === `antigravity/${gemini}`)!.context_window).toBe(1_024_000);
  const repeated = run(["--apply"]);
  expect(repeated.exitCode).toBe(0);
  expect(JSON.parse(repeated.stdout.toString()).changed).toEqual([]);
  const stable = readFileSync(catalog, "utf8");
  writeFileSync(join(home, "antigravity_gemini_3_8_flash_high.config.toml"), 'model="user-owned"\n');
  expect(run(["--apply", "--backup-dir", join(home, "conflict-backup")]).exitCode).not.toBe(0);
  expect(readFileSync(catalog, "utf8")).toBe(stable);
  expect(readFileSync(join(home, "antigravity_gemini_3_8_flash_high.config.toml"), "utf8")).toBe('model="user-owned"\n');
  const malformed = structuredClone(input.exported); malformed.models[0]!.model_context_window = -1;
  writeFileSync(join(home, "contracts.json"), JSON.stringify(malformed));
  expect(run(["--apply", "--backup-dir", join(home, "bad-backup")]).exitCode).not.toBe(0);
  expect(readFileSync(catalog, "utf8")).toBe(stable);
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(auth);
});
