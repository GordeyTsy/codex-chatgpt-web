import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { createHash } from "node:crypto";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "custom-action-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec_command", description: "Fixture command", parameters: { type: "object" } }],
  }, 60_000, "custom-action-fixture");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const client = new Client({ name: "custom-action-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socket],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  }));
  return {
    root,
    broker,
    token,
    client,
    close: async () => {
      await client.close();
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("codex_report_failure issues a turn-scoped codex_custom_action code", async () => {
  const f = await fixture();
  try {
    const instructions = f.client.getInstructions() ?? "";
    expect(instructions).toContain("codex_custom_action");
    expect(instructions).toContain("EXEC_FAIL");
    const tools = (await f.client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toContain("codex_report_failure");
    expect(tools.map(tool => tool.name)).toContain("codex_custom_action");

    const command = "printf CCA_NATIVE_RESULT";
    const report = await f.client.callTool({ name: "codex_report_failure", arguments: {
      turn_token: f.token,
      failed_tool: "codex_exec",
      command,
      visible_error: "Synthetic pre-bridge rejection",
      category: "safety_rejection",
    } });
    const expectedCode = `cca ${createHash("sha256").update(command).digest("hex")}`;
    expect(report.structuredContent).toMatchObject({
      marker: "EXEC_FAIL",
      recorded: true,
      executed: false,
      cca: expectedCode,
    });

    const pending = f.client.callTool({ name: "codex_custom_action", arguments: {
      turn_token: f.token,
      code: expectedCode,
    } });
    const [request] = await f.broker.nextToolBatch(f.token);
    expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: command } });
    f.broker.completeTool(f.token, request!.callId, {
      content: [{ type: "text", text: JSON.stringify({ exit: 0, output: "CCA_NATIVE_RESULT" }) }],
    });
    const reply = await pending;
    expect(JSON.stringify(reply)).toContain("CCA_NATIVE_RESULT");
  } finally {
    await f.close();
  }
});

test("custom action codes cannot be guessed or used in another turn", async () => {
  const f = await fixture();
  const otherToken = await f.broker.register({
    cwd: f.root,
    roots: [f.root],
    writableRoots: [f.root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec_command", description: "Fixture command", parameters: { type: "object" } }],
  }, 60_000, "custom-action-other-turn");
  try {
    const command = "printf MUST_NOT_RUN";
    const report = await f.client.callTool({ name: "codex_report_failure", arguments: {
      turn_token: f.token,
      failed_tool: "codex_exec",
      command,
      visible_error: "Synthetic pre-bridge rejection",
      category: "safety_rejection",
    } });
    const code = (report.structuredContent as { cca?: string }).cca;
    expect(code).toStartWith("cca ");
    const guessed = `cca ${createHash("sha256").update("printf GUESSED").digest("hex")}`;
    const guessedReply = await f.client.callTool({ name: "codex_custom_action", arguments: { turn_token: f.token, code: guessed } });
    expect(guessedReply.isError).toBeTrue();
    const crossTurnReply = await f.client.callTool({ name: "codex_custom_action", arguments: { turn_token: otherToken, code: code! } });
    expect(crossTurnReply.isError).toBeTrue();
    expect(f.broker.beginCompletionFence(f.token)).toBe(4);
  } finally {
    await f.close();
  }
});
