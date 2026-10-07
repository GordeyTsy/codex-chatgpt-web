import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompactionFile, validateCompactionFileAnswer } from "../src/adapters/chatgpt-web/compaction-file";
import { CompactionFallbackPolicy, COMPACTION_FILE_COOLDOWN_MS, isCompactionTransportFailure } from "../src/adapters/chatgpt-web/compaction-fallback";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptBrowserWorker, chatGptPromptFilePayloads, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const summary = "Owner goal: finish the approved plan. Writer A owns the existing worktree; review remains pending. Completed effects must not be replayed.";
const error = (code: string) => new ChatGptWebAdapterError("fixture", { status: 502, errorType: "server_error", code, retryable: false });
const response = (archive: ReturnType<typeof buildCompactionFile>) => ({ archive_sha256: archive.manifest.archiveSha256,
  coverage: archive.manifest.sections.map(s => ({ index: s.index, start_check: s.startCheck, end_check: s.endCheck })), summary });

test("six section reads reconstruct Unicode context byte-for-byte and checks are absent from prompt", () => {
  const context = JSON.stringify({ messages: Array.from({ length: 25 }, (_, i) => `${i}:Привет🙂\n${"q".repeat(i)}`) });
  const archive = buildCompactionFile(context);
  const pieces = [...archive.file.text.matchAll(/READ_START_CHECK=[a-f0-9]+\n([\s\S]*?)\nREAD_END_CHECK=[a-f0-9]+/g)];
  expect(pieces.map(m => m[1]).join("")).toBe(context);
  expect(pieces).toHaveLength(6);
  for (const section of archive.manifest.sections) {
    expect(archive.prompt).not.toContain(section.startCheck);
    expect(archive.prompt).not.toContain(section.endCheck);
  }
  expect(validateCompactionFileAnswer(JSON.stringify(response(archive)), archive.manifest)).toBe(summary);
});

test("provided native loader displays a large Unicode archive completely with the advertised bounded call count", () => {
  const root = mkdtempSync(join(tmpdir(), "compact-loader-"));
  try {
    const context = JSON.stringify({ messages: ["🙂Привет\n".repeat(20_000), "latest goal and exact completed effect"] });
    const archive = buildCompactionFile(context);
    const path = join(root, archive.file.name);
    writeFileSync(path, archive.file.text);
    const program = archive.prompt.match(/```python\n([\s\S]*?)\n```/)![1]!
      .replace("Path('/mnt/data')", `Path(${JSON.stringify(root)})`).replace(/\nread_next\(\)$/, "");
    const displayed: string[] = JSON.parse(execFileSync("python3", ["-c", program +
      "\nimport io, json\nfrom contextlib import redirect_stdout\noutputs=[]\nfor _ in range(len(pages)):\n    output=io.StringIO()\n    with redirect_stdout(output): read_next()\n    outputs.append(output.getvalue()[:-1])\nprint(json.dumps(outputs))"], { maxBuffer: 2_000_000 }).toString());
    expect(displayed).toHaveLength(Number(archive.prompt.match(/exactly (\d+) bounded page reads/)![1]));
    expect(displayed.every(page => Array.from(page).length <= 12_000)).toBeTrue();
    expect(displayed.join("").replace(/READ_START_CHECK=[a-f0-9]+\n/g, "").replace(/\nREAD_END_CHECK=[a-f0-9]+\n/g, "")).toBe(context);
    expect(archive.prompt).not.toContain("print(sections[");
    expect(buildCompactionFile("short history").prompt).toContain("exactly 6 bounded page reads");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["missing", "duplicate", "foreign", "wrong-check", "empty-summary", "incomplete"])("incomplete coverage cannot become a native checkpoint: %s", variant => {
  const archive = buildCompactionFile("fixture context");
  const answer = response(archive);
  if (variant === "missing") answer.coverage.pop();
  if (variant === "duplicate") answer.coverage[5] = answer.coverage[0]!;
  if (variant === "foreign") answer.archive_sha256 = "foreign";
  if (variant === "wrong-check") answer.coverage[2]!.end_check = "invented";
  if (variant === "empty-summary") answer.summary = "";
  if (variant === "incomplete") answer.summary = "COMPACTION_INPUT_INCOMPLETE";
  expect(() => validateCompactionFileAnswer(JSON.stringify(answer), archive.manifest)).toThrow("archive-bound");
});

test("observed browser citation expansion inside fenced JSON does not corrupt a valid checkpoint", () => {
  const archive = buildCompactionFile("fixture context");
  const json = JSON.stringify(response(archive)).replace("Owner goal:", 'Owner goal: :chatgpt-content-reference{index="0"}');
  expect(validateCompactionFileAnswer("```\n" + json + "\n```", archive.manifest)).toContain("finish the approved plan");
  expect(validateCompactionFileAnswer("```json\n" + JSON.stringify(response(archive)) + "\n```", archive.manifest)).toBe(summary);
});

test("fallback persists exactly three hours, expires to standard, and isolates providers", () => {
  const root = mkdtempSync(join(tmpdir(), "compact-policy-"));
  let now = 1_000_000;
  const path = join(root, "state.json");
  try {
    const policy = new CompactionFallbackPolicy(path, "provider-one", () => now);
    expect(policy.active()).toBeFalse();
    const expiry = policy.activate(error("chatgpt_model_no_progress"));
    expect(expiry).toBe(now + COMPACTION_FILE_COOLDOWN_MS);
    now += COMPACTION_FILE_COOLDOWN_MS - 1;
    expect(policy.activate(error("rate_limit_exceeded"))).toBe(expiry);
    expect(new CompactionFallbackPolicy(path, "provider-one", () => now).active()).toBeTrue();
    expect(new CompactionFallbackPolicy(path, "provider-two", () => now).active()).toBeFalse();
    now += 1;
    expect(policy.active()).toBeFalse();
    expect(new CompactionFallbackPolicy(path, "provider-one", () => now).active()).toBeFalse();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["client_cancelled", "chatgpt_sign_in_required", "chatgpt_session_expired", "chatgpt_pro_quota_exhausted", "chatgpt_safety_recovery", "compaction_file_incomplete"])("does not use attachment transport to recover cancellation/auth/quota/denial: %s", code => {
  expect(isCompactionTransportFailure(error(code))).toBeFalse();
});

test("file compaction uploads all history once without six stage messages or skill substitution", () => {
  const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "max" }, _compactionRequest: true,
    context: { systemPrompt: ["preserve system"], messages: [
      { role: "user", origin: "codex_skill", content: "<skill><name>fixture</name>read skill</skill>", timestamp: 1 },
      { role: "user", content: "preserve latest task " + "history ".repeat(40_000), timestamp: 2 },
    ] } };
  const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true }, undefined, { fileCompaction: true });
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.skillFiles).toBeUndefined();
  expect(compiled.contextFiles![0]!.text).toContain("read skill");
  expect(compiled.contextFiles![0]!.text).toContain("preserve latest task");
  expect(chatGptPromptFilePayloads(compiled)).toHaveLength(1);
  expect(estimateCompiledChatGptWebMessageTokens(compiled, parsed.modelId)).toBeLessThan(2_000);
  expect(() => compileChatGptWebPrompt({ ...parsed, _compactionRequest: undefined }, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true }, undefined, { fileCompaction: true })).toThrow("isolated compaction");
});

test("one standard failure switches the same compact and the next compact directly to file without changing model", async () => {
  const root = mkdtempSync(join(tmpdir(), "compact-switch-"));
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://switch-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"), localToolsEnabled: false,
      experimentalBiggerContext: true, solAvailable: true, proAvailable: true, extraHighAvailable: true } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const original = worker.run;
  const formats: string[] = [];
  (worker as unknown as { run(turn: BrowserTurn): Promise<string> }).run = async turn => {
    expect(turn.reasoning).toBe("max");
    expect(turn.modelFamily).toBe("6");
    const prepared = await turn.prepare();
    formats.push(prepared.compactionFile ? "file" : "standard");
    if (formats.length === 1) { expect(prepared.multipart?.parts).toHaveLength(6); throw error("chatgpt_model_no_progress"); }
    expect(prepared.contextFiles).toHaveLength(1);
    return JSON.stringify({ archive_sha256: prepared.compactionFile!.archiveSha256,
      coverage: prepared.compactionFile!.sections.map(s => ({ index: s.index, start_check: s.startCheck, end_check: s.endCheck })), summary });
  };
  try {
    for (let round = 0; round < 2; round++) {
      const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", _chatgptModelFamily: "6", _compactionRequest: true,
        stream: true, options: { reasoning: "max" }, context: { messages: [{ role: "user", content: "Preserved task", timestamp: 1 }] },
        _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved task" }],
          internal_chat_message_metadata_passthrough: { turn_id: `compact-fixture-turn-${round}` } }],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `compact-fixture-${round}`, turn_id: `compact-fixture-turn-${round}` }) } } };
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(events.filter(event => event.type === "text_delta").map(event => (event as any).text).join("")).toBe(summary);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    }
    expect(formats).toEqual(["standard", "file", "file"]);
  } finally { worker.run = original; chatGptTurnSessions.clear(); rmSync(root, { recursive: true, force: true }); }
});
