import { expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../src/config";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
} from "../src/adapters/chatgpt-web/browser-worker";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const fixed = { contextWindow: 500_000, effectiveContextWindowPercent: 100, autoCompactTokenLimit: 450_000 };
const plus = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: false };

test("every named and legacy Web route uses the fixed window; native and external rows stay intact", () => {
  const original = {
    models: [
      { slug: "native", visibility: "list", tool_mode: "code_mode_only", supported_reasoning_levels: [],
        context_window: 300_000, max_context_window: 320_000, effective_context_window_percent: 95 },
      { slug: "antigravity/gemini-3.8-flash-high", context_window: 1_024_000 },
      { slug: "z-ai/glm-5.3", context_window: 300_000 },
    ],
  };
  for (const capabilities of [
    {}, { proAvailable: true }, { solAvailable: false },
    { browserInteractionMode: "manual" as const, zeroRiskProEnabled: true },
  ]) {
    const config = { ...defaultConfig("full"), subagentProtocol: "native" as const, ...capabilities, fixedWebContextWindow: 500_000 };
    for (const bigger of [false, true]) {
      if (config.browserInteractionMode === "manual" && bigger) continue;
      config.experimentalBiggerContext = bigger;
      const models = augmentNativeModelCatalog(original, config).models as Array<Record<string, unknown>>;
      expect(models.slice(0, 3)).toEqual(original.models);
      const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
      expect(web.length).toBeGreaterThan(0);
      for (const row of web) expect(row).toMatchObject({
        context_window: fixed.contextWindow, max_context_window: fixed.contextWindow,
        effective_context_window_percent: fixed.effectiveContextWindowPercent,
        auto_compact_token_limit: fixed.autoCompactTokenLimit,
      });
    }
    expect(providerConfig(config).chatgptWeb?.fixedWebContextWindow).toBe(500_000);
  }
});

test("fixed Web window applies to runtime preflight but does not enlarge one browser message", () => {
  for (const proAvailable of [false, true]) {
    const defaults = { ...plus, proAvailable };
    const capabilities = { ...defaults, fixedWebContextWindow: 500_000 };
    for (const effort of ["low", "medium", "high", "xhigh", ...(proAvailable ? ["max" as const] : [])] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities)).toEqual(fixed);
      expect(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities))
        .toBe(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, effort, defaults));
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities))
        .toEqual(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, defaults));
    }
  }
  for (const model of [CHATGPT_WEB_LUNA_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL] as const) {
    expect(resolveChatGptWebContextLimits(model, "low", { ...plus, fixedWebContextWindow: 500_000 })).toEqual(fixed);
  }
  const capabilities = { ...plus, fixedWebContextWindow: 500_000 };
  expect(() => assertChatGptWebInputWithinLimits(120_000, 110_000, CHATGPT_WEB_BACKEND_MODEL, "high", capabilities, 400_000))
    .toThrow("transport budget");
  expect(() => assertChatGptWebInputWithinLimits(499_999, 10_000, CHATGPT_WEB_BACKEND_MODEL, "high", capabilities, 40_000)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(500_000, 10_000, CHATGPT_WEB_BACKEND_MODEL, "high", capabilities, 40_000))
    .toThrow("500,000-token context window");
  expect(() => assertChatGptWebMultipartInputWithinLimits(449_999, 80_000, CHATGPT_WEB_BACKEND_MODEL, "high", capabilities, 400_000, 6)).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(500_000, 80_000, CHATGPT_WEB_BACKEND_MODEL, "high", capabilities, 400_000, 6))
    .toThrow("500,000-token");
  expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", { ...plus, fixedWebContextWindow: NaN }))
    .toThrow("positive safe integer");
});

test("multipart planning still splits a large request using measured stage envelopes", () => {
  const capabilities = { ...plus, fixedWebContextWindow: 500_000 };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_BACKEND_MODEL, stream: false, options: { reasoning: "high" },
    context: { messages: Array.from({ length: 12 }, () => ({ role: "user" as const, timestamp: Date.now(), content: "a!b@c#d$e%f^g&h*".repeat(1_500) })) },
    _rawBody: {},
  };
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  const budget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, "high", plus);
  for (const message of compiledChatGptWebMessages(compiled)) {
    expect(estimateTokens(message, parsed.modelId)).toBeLessThanOrEqual(budget);
  }
});
