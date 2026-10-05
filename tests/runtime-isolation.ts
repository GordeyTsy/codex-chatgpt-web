import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Even adapters that never start a broker create a default broker object. Every test process,
// including direct `bun test ./tests`, must resolve that default into a disposable runtime.
// Never let teardown from a checkout (especially an older one) touch the installed runtime.
const runtimeHome = mkdtempSync(join(tmpdir(), "cgw-test-"));
process.env.CODEX_CHATGPT_WEB_HOME = runtimeHome;
process.once("exit", () => rmSync(runtimeHome, { recursive: true, force: true }));
