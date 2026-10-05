import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

// Isolated DOM fixture: real Chromium, real response projection and terminal fence path;
// model selection/submission setup is test-only and does not invoke a provider.
test.each([true, false])("browser binding verdict precedes fence retirement and final text (failure=%s)", async failure => {
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
  try {
    const result = worker.runBrowserTurn({
      traceId: "binding_fixture", modelId: "gpt-5.6-sol", reasoning: "xhigh", capabilities,
      prepare: async () => ({ text: "Isolated test context", images: [], release: () => {} }),
      onTextDelta: (delta: string) => { text += delta; }, externalProgress: new ChatGptExternalTurnProgress(),
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
