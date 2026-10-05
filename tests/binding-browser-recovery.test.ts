import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

// Isolated DOM fixture: real Chromium, real response projection and terminal fence path;
// model selection/submission setup is test-only and does not invoke a provider.
test.each([
  { failure: true, historicalTools: false },
  { failure: false, historicalTools: false },
  { failure: false, historicalTools: true },
])("browser binding verdict precedes fence retirement and final text (%j)", async ({ failure, historicalTools }) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "binding-browser-"));
  const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(3_000);
  const answer = failure
    ? "Не смог продолжить выполнение I1: Codex bridge отклонил вызов с ошибкой turn token is invalid, expired, or revoked."
    : "The token error is diagnosed and the source checks completed.";
  await page.setContent(`<main><article data-message-author-role="assistant" data-message-id="current">
    <div class="markdown"><p>${answer}</p></div><button data-testid="copy-turn-action-button">Copy</button>
    </article><div data-testid="prompt-textarea" contenteditable="true"></div></main>`);
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native", autoApproveToolCalls: false, browserDiagnosticsPath: diagnostics, turnTimeoutMs: 30_000 },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => resolveChatGptWebModelMode("gpt-5.6-sol", "xhigh", capabilities),
    captureSubmissionBaseline: async () => ({}),
    attachPromptWithCompactionRetry: async () => {},
    attachFiles: async () => {},
    sendAttachedPrompt: async () => "user_turn",
    waitForNewAssistantTurn: async () => ({ locator: page.locator("article"), identity: "current" }),
  });
  let begins = 0, commits = 0, text = "";
  const progress = new ChatGptExternalTurnProgress();
  if (historicalTools) {
    const batch = progress.recordToolBatch(73);
    await progress.acknowledgeToolBatch(batch);
    for (let index = 0; index < 73; index++) progress.recordToolResult();
  }
  try {
    const result = worker.runBrowserTurn({
      traceId: "binding_fixture", modelId: "gpt-5.6-sol", reasoning: "xhigh", capabilities,
      prepare: async () => ({ text: "Isolated test context", images: [], release: () => {} }),
      onTextDelta: (delta: string) => { text += delta; }, externalProgress: progress,
      completionFence: { begin: async () => { begins++; return 1; }, commit: async () => { commits++; return true; } },
    }, undefined, page);
    if (failure) {
      await expect(result).rejects.toMatchObject({ code: "chatgpt_turn_token_mismatch" });
      expect(begins).toBe(0); expect(commits).toBe(0); expect(text).toBe("");
    } else {
      expect(await result).toBe(answer); expect(text).toBe(answer); expect(commits).toBe(1);
    }
  } finally { await browser.close(); rmSync(diagnostics, { recursive: true, force: true }); }
}, 45_000);

// Real browser + production staging reader/timer. Setup is isolated and invokes no model.
test("recovered multipart confirmation completes in a real browser with 73 historical tool results", async () => {
  const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const progress = new ChatGptExternalTurnProgress();
  const batch = progress.recordToolBatch(73);
  await progress.acknowledgeToolBatch(batch);
  for (let index = 0; index < 73; index++) progress.recordToolResult();
  let repeatedAcknowledgements = 0;
  const originalAcknowledge = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async revision => {
    repeatedAcknowledgements++;
    await originalAcknowledge(revision);
  };
  await page.setContent('<article data-message-author-role="assistant" data-message-id="stage-2">'
    + '<div class="markdown"><p>CONTEXT_ACK_2</p></div>'
    + '<button data-testid="copy-turn-action-button">Copy</button></article>');
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  try {
    await worker.waitForMultipartAcknowledgement(page,
      { locator: page.locator("article"), identity: "stage-2" }, {},
      { acknowledgement: "CONTEXT_ACK_2" }, Date.now() + 3_000, undefined, progress,
      new ChatGptCompletionTracker(0, 50));
    expect(repeatedAcknowledgements).toBe(0);
    expect(progress.snapshot()).toMatchObject({ revision: 74, lastToolBatchRevision: batch, activeToolCalls: 0 });
  } finally { await browser.close(); }
}, 15_000);

// Real browser + production staging reader/timer. Setup is isolated and invokes no model.
test.each([false, true])("multipart stall keeps final tools unsent and preserves owner cancellation (cancel=%s)", async cancel => {
  const diagnostics = mkdtempSync(join(tmpdir(), "multipart-stall-browser-"));
  const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setContent('<main></main><div data-testid="prompt-textarea" contenteditable="true"></div>');
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const owner = new AbortController();
  let finalSends = 0, toolAttachments = 0, stageSends = 0, released = false, readerEntered = false;
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native", autoApproveToolCalls: false, browserDiagnosticsPath: diagnostics,
      modelProgressTimeoutMs: 300_000, turnTimeoutMs: 30_000 },
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(model, effort, capabilities),
    attachPrompt: async (_page: unknown, _text: string, tools: boolean) => { if (tools) toolAttachments++; },
    attachPromptWithCompactionRetry: async () => { toolAttachments++; },
    attachFiles: async () => {},
    runStage: (...args: any[]) => {
      if (args[1].endsWith("_acknowledgement")) args[2] = 5_000;
      return (ChatGptBrowserWorker.prototype as any).runStage.apply(worker, args);
    },
    waitForMultipartAcknowledgement: (...args: any[]) => {
      readerEntered = true;
      if (cancel) owner.abort(new DOMException("Owner stopped task", "AbortError"));
      return (ChatGptBrowserWorker.prototype as any).waitForMultipartAcknowledgement.apply(worker, args);
    },
    sendAttachedPrompt: async (_page: unknown, baseline: any) => {
      stageSends++;
      await page.locator("main").evaluate((node, prompt) => {
        node.innerHTML = '<section data-turn-id-container="submitted"><article data-testid="conversation-turn-0" data-message-author-role="user" data-turn-id="submitted"></article></section>'
          + '<section data-turn-id-container="staging"><article data-testid="conversation-turn-1" data-message-author-role="assistant" data-turn-id="staging"><div class="markdown"></div></article></section>'
          + '<button data-testid="stop-button" onclick="this.remove()">Stop</button>';
        node.querySelector("article")!.textContent = prompt;
      }, baseline.submittedText);
      return "user_turn";
    },
  });
  try {
    const run = worker.runBrowserTurn({ traceId: "multipart_stall_fixture", modelId: "gpt-5.6-sol", reasoning: "xhigh", capabilities,
      abortSignal: owner.signal, externalProgress: new ChatGptExternalTurnProgress(),
      completionFence: { begin: async () => { throw new Error("No final task may start during staging"); }, commit: async () => false },
      onSendActivated: () => { finalSends++; }, onTextDelta: () => {},
      prepare: async () => ({ text: "Isolated context", images: [],
        multipart: { parts: ['{"part":1}', '{"part":2}'], commit: "Continue fixture" }, release: () => { released = true; } }),
    }, undefined, page);
    if (cancel) await expect(run).rejects.toMatchObject({ name: "AbortError" });
    else {
      await expect(run).rejects.toMatchObject({ code: "chatgpt_multipart_acknowledgement_timeout", retryable: false });
      const traceDir = join(diagnostics, readdirSync(diagnostics)[0]!);
      const captures = readdirSync(traceDir).filter(name => name.endsWith(".capture.json"));
      expect(captures).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(traceDir, captures[0]!), "utf8"))).toMatchObject({
        reason: "chatgpt_multipart_acknowledgement_timeout", saved: ["png", "html", "txt", "page.json"], failed: [],
      });
    }
    expect(readerEntered).toBeTrue(); expect(stageSends).toBe(1); expect(finalSends).toBe(0); expect(toolAttachments).toBe(0); expect(released).toBeTrue();
    expect(await page.locator('[data-testid="stop-button"]').count()).toBe(0);
  } finally { await browser.close(); rmSync(diagnostics, { recursive: true, force: true }); }
}, 45_000);
