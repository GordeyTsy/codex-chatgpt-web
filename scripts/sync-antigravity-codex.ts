import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicWriteFile } from "../src/config";
import { parseCodexSyncExport, syncAntigravityCodex } from "../src/antigravity-codex-sync";

const { values } = parseArgs({ options: {
  contracts: { type: "string" }, catalog: { type: "string" }, routes: { type: "string" },
  gateway: { type: "string" }, config: { type: "string" }, "backup-dir": { type: "string" },
  apply: { type: "boolean", default: false }, help: { type: "boolean", default: false },
}, strict: true });
if (values.help) {
  console.log("Sync actual Antigravity Codex-button defaults into the multi-provider catalog and opt-in Codex profiles.\n"
    + "--contracts ABS --catalog ABS --routes ABS --gateway ABS --config ABS [--apply --backup-dir NEW_ABS]\n"
    + "Default: validate and report changes without writing files. Authentication and global model selection are preserved.");
  process.exit(0);
}
function path(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`--${name} requires an absolute path`);
  return resolve(value);
}
const names: string[] = ["catalog", "routes", "gateway", "config"];
const paths = [path("catalog"), path("routes"), path("gateway"), path("config")];
if (new Set(paths).size !== paths.length) throw new Error("Sync targets must be separate files");
const originals: Array<string | null> = paths.map(file => {
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error("Sync target exceeds the supported size");
  return readFileSync(file, "utf8");
});
const [catalog, routes, gateway] = originals.slice(0, 3).map(text => JSON.parse(text!));
const result = syncAntigravityCodex({ exported: parseCodexSyncExport(JSON.parse(readFileSync(path("contracts"), "utf8"))),
  catalog, routes, gateway, configText: originals[3]! });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const rendered = [json(result.catalog), json(result.routes), json(result.gateway), result.configText];
for (const [name, text] of Object.entries(result.profileConfigs)) {
  const file = join(dirname(paths[3]!), name);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before !== null && !before.startsWith("# BEGIN Antigravity Codex Sync profiles\n")
    && !before.startsWith("# BEGIN Antigravity Codex Sync profiles\r\n")) {
    throw new Error("An existing Codex profile file belongs to another writer; nothing was changed");
  }
  if (paths.includes(file)) throw new Error("Profile collides with a sync target");
  paths.push(file); names.push(name); originals.push(before); rendered.push(text);
}
const changed = rendered.map((text, index) => text === originals[index] ? -1 : index).filter(index => index >= 0);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
if (values.apply && changed.length) {
  const backup = path("backup-dir");
  if (existsSync(backup)) throw new Error("Backup directory must be new; prior backups are never overwritten");
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const index of changed) {
    const file = join(backup, `${names[index]}.before`);
    if (originals[index] !== null) { copyFileSync(paths[index]!, file); chmodSync(file, 0o600); }
  }
  atomicWriteFile(join(backup, "manifest.json"), json({ version: 1,
    files: changed.map(index => ({ name: names[index], path: paths[index], before_sha256: originals[index] === null ? null : hash(originals[index]!), after_sha256: hash(rendered[index]!) })) }));
  const written: number[] = [];
  try {
    for (const index of changed) {
      const current = existsSync(paths[index]!) ? readFileSync(paths[index]!, "utf8") : null;
      if (current !== originals[index]) throw new Error("Sync target changed during review; refusing to overwrite another writer");
      atomicWriteFile(paths[index]!, rendered[index]!);
      written.push(index);
    }
  } catch (error) {
    for (const index of written.reverse()) {
      if (readFileSync(paths[index]!, "utf8") === rendered[index]) {
        if (originals[index] === null) rmSync(paths[index]!);
        else atomicWriteFile(paths[index]!, originals[index]!);
      }
    }
    throw error;
  }
}
console.log(JSON.stringify({ applied: values.apply, changed: changed.map(index => names[index]),
  current_manager_models: result.currentModels, retained_legacy_models: result.retainedModels,
  codex_v2_profile_files: Object.keys(result.profileConfigs).length,
  global_model_and_auth_preserved: true, source: "Antigravity Codex sync handler export" }));
