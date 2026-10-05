import { describe, expect, test } from "bun:test";
import {
  parseSafetyFallbackBlock,
  stripSafetyFallback,
  hasSafetyFallbackMarker,
  SafetyFallbackStreamDetector,
  SAFETY_FALLBACK_START_TAG,
  SAFETY_FALLBACK_END_TAG,
} from "../src/adapters/chatgpt-web/safety-fallback";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";

describe("safety fallback parsing and detection", () => {
  test("parses standard <<<CODEX_SAFETY_FALLBACK>>> block with codex_exec", () => {
    const text = `Some earlier thoughts...
${SAFETY_FALLBACK_START_TAG}
{
  "failed_tool": "codex_exec",
  "command": "python3 -c \\"print('hello')\\""
}
${SAFETY_FALLBACK_END_TAG}
Trailing text`;

    const parsed = parseSafetyFallbackBlock(text);
    expect(parsed).toBeDefined();
    expect(parsed?.action).toEqual({
      tool: "codex_exec",
      command: 'python3 -c "print(\'hello\')"',
    });
  });

  test("parses alternative [CODEX_SAFETY_FALLBACK] tag with codex_apply_patch", () => {
    const patchContent = "*** Begin Patch\n+new line\n*** End Patch";
    const text = `[CODEX_SAFETY_FALLBACK]
{
  "failed_tool": "codex_apply_patch",
  "patch": ${JSON.stringify(patchContent)}
}
[/CODEX_SAFETY_FALLBACK]`;

    const parsed = parseSafetyFallbackBlock(text);
    expect(parsed).toBeDefined();
    expect(parsed?.action).toEqual({
      tool: "codex_apply_patch",
      patch: patchContent,
    });
  });

  test("parses fallback block wrapped in markdown json fence", () => {
    const text = `${SAFETY_FALLBACK_START_TAG}
\`\`\`json
{
  "failed_tool": "codex_tool_call",
  "wire_name": "list_files",
  "arguments": { "path": "/home/gt" }
}
\`\`\`
${SAFETY_FALLBACK_END_TAG}`;

    const parsed = parseSafetyFallbackBlock(text);
    expect(parsed).toBeDefined();
    expect(parsed?.action).toEqual({
      tool: "codex_tool_call",
      wireName: "list_files",
      arguments: { path: "/home/gt" },
      input: undefined,
    });
  });

  test("parses fallback block even if end tag is missing but JSON is complete", () => {
    const text = `${SAFETY_FALLBACK_START_TAG}
{
  "failed_tool": "codex_exec",
  "command": "git status"
}`;

    const parsed = parseSafetyFallbackBlock(text);
    expect(parsed).toBeDefined();
    expect(parsed?.action).toEqual({
      tool: "codex_exec",
      command: "git status",
    });
  });

  test("stripSafetyFallback completely removes the fallback block and any trailing text", () => {
    const text = `Hello world.
${SAFETY_FALLBACK_START_TAG}
{"failed_tool": "codex_exec", "command": "ls"}
${SAFETY_FALLBACK_END_TAG}`;

    const stripped = stripSafetyFallback(text);
    expect(stripped).toBe("Hello world.");
    expect(hasSafetyFallbackMarker(text)).toBe(true);
    expect(hasSafetyFallbackMarker(stripped)).toBe(false);
  });

  test("SafetyFallbackStreamDetector intercepts and suppresses streaming fallback chunks", () => {
    let triggeredAction: any = undefined;
    let triggeredReason = "";

    const detector = new SafetyFallbackStreamDetector((action, reason) => {
      triggeredAction = action;
      triggeredReason = reason;
    });

    // Chunk 1: Normal commentary
    const res1 = detector.observe("I need to run a command. ");
    expect(res1.cleanChunk).toBe("I need to run a command. ");
    expect(res1.triggered).toBe(false);
    expect(triggeredAction).toBeUndefined();

    // Chunk 2: Starts fallback marker
    const res2 = detector.observe("<<<CODEX_SAFETY_FALLBACK");
    expect(res2.cleanChunk).toBe("");
    expect(res2.triggered).toBe(false);

    // Chunk 3: Emits payload and ends
    const res3 = detector.observe('>>>\n{"failed_tool":"codex_exec","command":"echo success"}\n<<<END_CODEX_SAFETY_FALLBACK>>>');
    expect(res3.cleanChunk).toBe("");
    expect(res3.triggered).toBe(true);
    expect(triggeredAction).toEqual({
      tool: "codex_exec",
      command: "echo success",
    });
    expect(triggeredReason).toBe("text_fallback_detected");

    // Chunk 4: Further chunks are discarded
    const res4 = detector.observe("Should be dropped");
    expect(res4.cleanChunk).toBe("");
    expect(res4.triggered).toBe(true);
  });
});

describe("turn broker safety recovery methods", () => {
  test("setPendingCustomAction, getPendingCustomAction, and clearPendingCustomAction work on channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "broker-safety-test-"));
    const socket = defaultBrokerEndpoint(root);
    const broker = TurnBroker.forSocket(socket);

    try {
      const token = await broker.register({
        cwd: root,
        roots: [root],
        writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" },
        tools: [{ name: "exec_command", description: "exec", parameters: { type: "object" } }],
      }, 60_000, "safety-test-trace");

      expect(broker.getPendingCustomAction(token)).toBeUndefined();

      const action = { tool: "codex_exec" as const, command: "echo test" };
      broker.setPendingCustomAction(token, action, "cca 12345678");

      const pending = broker.getPendingCustomAction(token);
      expect(pending).toBeDefined();
      expect(pending?.ccaCode).toBe("cca 12345678");
      expect(pending?.action).toEqual(action);

      const cleared = broker.clearPendingCustomAction(token);
      expect(cleared).toEqual(action);
      expect(broker.getPendingCustomAction(token)).toBeUndefined();
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("queueDirectAction enqueues native tool call and nextToolBatch receives it", async () => {
    const root = mkdtempSync(join(tmpdir(), "broker-queue-test-"));
    const socket = defaultBrokerEndpoint(root);
    const broker = TurnBroker.forSocket(socket);

    try {
      const token = await broker.register({
        cwd: root,
        roots: [root],
        writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" },
        tools: [{ name: "exec_command", description: "exec", parameters: { type: "object" } }],
      }, 60_000, "safety-queue-trace");

      const action = { tool: "codex_exec" as const, command: "ls -la /tmp" };
      const queuedPromise = broker.queueDirectAction(token, action);

      const [batch] = await Promise.all([
        broker.nextToolBatch(token),
        queuedPromise,
      ]);

      expect(batch).toBeDefined();
      expect(batch.length).toBe(1);
      expect(batch[0].wireName).toBe("exec_command");
      expect(batch[0].arguments).toEqual({ cmd: "ls -la /tmp" });
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
