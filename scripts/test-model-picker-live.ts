/** Verify the authenticated site's picker without submitting any ChatGPT messages. */
import { loadConfig } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ROUTES, type ChatGptWebModelFamily } from "../src/chatgpt-web-models";
import { chatGptNewChatUrl } from "../src/chatgpt-session";
import { connectLauncherBrowserHost, notifyLauncherTurn } from "../src/launcher-browser-host";
import type { Browser } from "playwright-core";

if (process.argv.includes("--help")) {
  console.log("bun scripts/test-model-picker-live.ts — verify all named model/effort combinations and Latest staging levels; sends no messages.");
  process.exit(0);
}
const config = loadConfig();
if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
  throw new Error("This verification requires the running launcher browser host");
}
const descriptorPath = config.browserHostDescriptorPath;
const traceId = `picker_verification_${Date.now()}`;
const helperPid = process.pid;
let browser: Browser | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const results: Record<string, unknown>[] = [];
try {
  const lease = await notifyLauncherTurn(descriptorPath, { phase: "start", traceId, helperPid });
  heartbeat = setInterval(() => {
    void notifyLauncherTurn(descriptorPath, { phase: "heartbeat", traceId, helperPid }).catch(() => {});
  }, 10_000);
  const connection = await connectLauncherBrowserHost(descriptorPath, 20_000, lease.surfaceId);
  browser = connection.browser;
  const page = connection.page;
  page.setDefaultTimeout(7_000);
  await page.goto(chatGptNewChatUrl(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Exercise the worker's production selection and pre-submission confirmation methods.
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config });
  const targets = CHATGPT_WEB_MODEL_ROUTES.flatMap(route => (route.supportedCodexEfforts ?? [route.codexEffort]).map(effort => ({
    slug: route.slug, family: route.modelFamily!, effort,
  })));
  targets.push(...["low", "medium", "high", "xhigh"].map(effort => ({
    slug: "internal Latest staging", family: "6" as ChatGptWebModelFamily, effort: effort as "low" | "medium" | "high" | "xhigh",
  })));
  for (const target of targets) {
    const started = performance.now();
    try {
      const mode = await worker.selectModelAndEffort(page, "gpt-5.6-sol", target.effort, {
        localToolsEnabled: false,
        solAvailable: config.solAvailable,
        extraHighAvailable: config.extraHighAvailable,
        proAvailable: config.proAvailable,
      }, undefined, true, target.family);
      await worker.assertSelectedEffort(page, mode);
      const row = { ...target, ok: true, label: mode.selection.label, usageModel: mode.usageModel, durationMs: performance.now() - started };
      results.push(row); console.log(JSON.stringify(row));
    } catch (error) {
      const row = { ...target, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started };
      results.push(row); console.log(JSON.stringify(row));
      throw error;
    }
  }
  console.log(JSON.stringify({ kind: "authenticated-picker-only", ok: true, messagesSent: 0, results }));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  await notifyLauncherTurn(descriptorPath, {
    phase: "end", traceId, helperPid, status: results.length === 10 && results.every(row => row.ok) ? "completed" : "aborted", retain: false,
  }).catch(() => {});
}
