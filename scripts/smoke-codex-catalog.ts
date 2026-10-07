import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHATGPT_WEB_MODEL_ROUTES, availableChatGptWebModelRoutes, chatGptWebRouteEfforts } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

const currentMacCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const codex = resolve(process.argv[2] ?? (process.platform === "darwin" && existsSync(currentMacCodex)
  ? currentMacCodex : "/Applications/ChatGPT.app/Contents/Resources/codex"));
function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 15_000,
    // Hidden task identities also carry the native harness metadata in this JSON response.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const bundled = runCodex(["debug", "models", "--bundled"]);
const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
  throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
process.env.CODEX_HOME = join(root, "codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const config = defaultConfig("browser-only");
config.proAvailable = true;
config.subagentProtocol = "compatibility-v1";
const catalogPath = join(root, "augmented-models.json");
writeFileSync(catalogPath, `${JSON.stringify(augmentNativeModelCatalog(sourceCatalog, config))}\n`);
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), [
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  "",
  "[features]",
  "multi_agent = true",
  "multi_agent_v2 = false",
  "",
].join("\n"));
try {
  const isolatedEnv = { ...process.env, CODEX_HOME: process.env.CODEX_HOME };
  const result = runCodex(["debug", "models"], isolatedEnv);
  const catalog = JSON.parse(result.stdout) as {
    models?: Array<{
      slug?: string;
      supported_reasoning_levels?: unknown[];
      multi_agent_version?: string;
      supported_in_api?: boolean;
      visibility?: string;
      priority?: number;
    }>;
  };
  const web = catalog.models?.filter(model => model.slug?.startsWith("chatgpt-web/")) ?? [];
  const expected = availableChatGptWebModelRoutes(config, true).map(route => ({
    slug: route.slug, visibility: route.legacy ? "hide" : "list", effort: chatGptWebRouteEfforts(route, config).join(","),
  }));
  const actual = web.map(model => ({
    slug: model.slug,
    visibility: model.visibility,
    effort: Array.isArray(model.supported_reasoning_levels)
      ? (model.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort).join(",")
      : "",
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Codex did not preserve the grouped and legacy ChatGPT Web model contract: ${JSON.stringify(actual)}`);
  }
  const nativeSol = catalog.models?.find(model => model.slug === "gpt-5.6-sol");
  const webPro = catalog.models?.find(model => model.slug === "chatgpt-web/pro");
  if (nativeSol?.multi_agent_version !== "v1" || webPro?.multi_agent_version !== "v1") {
    throw new Error(
      `Codex did not preserve Compatibility V1 catalog metadata: ${JSON.stringify({ nativeSol, webPro })}`,
    );
  }
  const features = runCodex(["features", "list"], isolatedEnv).stdout;
  if (!/^multi_agent\s+stable\s+true$/m.test(features)
    || !/^multi_agent_v2\s+stable\s+false$/m.test(features)) {
    throw new Error(`Codex did not load the Compatibility V1 feature override:\n${features}`);
  }
  const spawnOverrides = (catalog.models ?? [])
    .filter(model => model.supported_in_api === true && model.visibility === "list")
    .toSorted((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 5)
    .map(model => model.slug);
  const nativeRows = sourceCatalog.models as Array<{
    slug: string; visibility: string; supported_in_api: boolean; priority?: number; supported_reasoning_levels?: unknown[];
  }>;
  const template = nativeRows.find(model => model.visibility === "list" && Array.isArray(model.supported_reasoning_levels));
  if (!template) throw new Error("Native catalog has no visible reasoning template");
  // The CLI's native catalog can add a model ahead of the first visible template
  // (0.160.1 has 6.1 Sol ahead of Astra). Preserve every native row in that prefix.
  const nativeLeaders = nativeRows
    .filter(model => model.supported_in_api && model.visibility === "list"
      && (model.priority ?? Number.MAX_SAFE_INTEGER) <= (template.priority ?? Number.MAX_SAFE_INTEGER))
    .toSorted((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
  const requiredWebOverrides = CHATGPT_WEB_MODEL_ROUTES.slice(1).map(route => route.slug);
  const expectedSpawnOverrides = [
    ...nativeLeaders.map(model => model.slug),
    ...CHATGPT_WEB_MODEL_ROUTES.slice(1).map(route => route.slug),
    "chatgpt-web/gpt-5.6-sol-instant",
  ].slice(0, 5);
  if (!requiredWebOverrides.every(slug => spawnOverrides.includes(slug))) {
    throw new Error(`Native catalog displaced a required WEB subagent model: ${JSON.stringify(spawnOverrides)}`);
  }
  if (JSON.stringify(spawnOverrides) !== JSON.stringify(expectedSpawnOverrides)) {
    throw new Error(`Codex did not preserve the bounded V1 subagent roster: ${JSON.stringify(spawnOverrides)}`);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
