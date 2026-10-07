import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { validateCompactionFileAnswer } from "../src/adapters/chatgpt-web/compaction-file";
import type { CodexParsedRequest } from "../src/types";

// Explicit descriptor opt-in: never discover an account or mutate Codex configuration.
const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--launcher-descriptor") || !args.includes("--output-dir")) {
  throw new Error("Required: --launcher-descriptor PATH --output-dir PRIVATE_DIR [--padding-chars N]");
}
process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
const descriptor = resolve(arg("--launcher-descriptor")!);
const output = resolve(arg("--output-dir")!);
mkdirSync(output, { recursive: true, mode: 0o700 });
const padding = Number(args.includes("--padding-chars") ? arg("--padding-chars") : "0");
if (!Number.isInteger(padding) || padding < 0 || padding > 2_000_000) throw new Error("Invalid padding size");
const facts = [
  "Latest goal: implement plan; tests must use actual process integrations. Writer Orion owns A, Vega owns G; they must never write each other's scope.",
  "A worktree /synthetic/owned-a HEAD 1111111111111111111111111111111111111111. Accepted SOURCE_ONLY; live Kubernetes and cutover NOT_RUN. A PVC webhook remains OPEN.",
  "G worktree /synthetic/owned-g HEAD 2222222222222222222222222222222222222222. Native target implementation exists; last turn INTERRUPTED, not completed or reviewed.",
  "Completed effect: DELIVERY_CASE_83 acknowledged once; never acknowledge it again. Test PROCESS_REPLAY_27 passed 7/7 exit 0. Broad suite passed 159/159 exit 0.",
  "Finding FIX_REPLAY_92 failed its single explicit correction; ownership transferred to coordinator. Failure count 2. Reserve C; I1 awaits independent root review. Source acceptance is not production acceptance.",
  "Latest steering supersedes older limit 3: FOUR workers concurrently, excluding coordinators. Resume G implementation from preserved dirty state; independently review A next. No publication authorized.",
];
const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", _chatgptModelFamily: "6", stream: true,
  _compactionRequest: true, options: { reasoning: "max" }, context: { systemPrompt: ["Summarize the supplied historical context faithfully."],
    messages: facts.flatMap((fact, i) => [
      { role: "user" as const, timestamp: i * 2 + 1, content: fact },
      { role: "assistant" as const, timestamp: i * 2 + 2, content: [{ type: "text" as const,
        text: `Historical analysis ${i}: ` + "Inert diagnostic prose with no new effects or acceptance. ".repeat(Math.ceil(padding / 6 / 57)) }] },
    ]).concat([{ role: "user", timestamp: 20, content: "Create a complete continuation checkpoint. Keep the exact names, identifiers, paths, hashes, statuses and counts of the six task-state entries. Return no task implementation." }] as any) } };
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { fileCompaction: true });
writeFileSync(join(output, "input-archive.txt"), compiled.contextFiles![0]!.text, { mode: 0o600 });
const worker = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: `browser://file-probe-${randomUUID()}`,
  chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: descriptor, localToolsEnabled: false,
    solAvailable: true, extraHighAvailable: true, proAvailable: true, browserDiagnosticsPath: join(output, "diagnostics"), turnTimeoutMs: 1_800_000 } });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("DEV file compaction probe deadline")), 1_800_000);
const started = Date.now();
try {
  const raw = await worker.run({ traceId: `dev_file_compact_${randomUUID().replaceAll("-", "")}`, modelId: parsed.modelId,
    modelFamily: "6", reasoning: "max", capabilities, compaction: true, abortSignal: controller.signal,
    prepare: async () => ({ ...compiled, release() {} }), onTextDelta() {},
    onReasoningSummary: text => console.log(JSON.stringify({ event: "visible_progress", text: text.slice(0, 180) })),
  });
  writeFileSync(join(output, "raw-answer.txt"), raw, { mode: 0o600 });
  const summary = validateCompactionFileAnswer(raw, compiled.compactionFile!);
  writeFileSync(join(output, "summary.txt"), summary, { mode: 0o600 });
  const required = ["Orion", "Vega", "/synthetic/owned-a", "/synthetic/owned-g", "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222", "DELIVERY_CASE_83", "PROCESS_REPLAY_27", "FIX_REPLAY_92", "7/7", "159/159"];
  const missing = required.filter(fact => !summary.includes(fact));
  const result = { coverage: "6/6", elapsedMs: Date.now() - started, archiveBytes: Buffer.byteLength(compiled.contextFiles![0]!.text),
    summaryChars: summary.length, missing, semanticReviewRequired: true };
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  if (missing.length) throw new Error("File checkpoint dropped required fixture state");
} finally { clearTimeout(timer); await worker.close(); }
