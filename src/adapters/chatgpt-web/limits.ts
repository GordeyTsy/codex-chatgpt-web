import type { Locator, Page } from "playwright-core";
import { readChatGptModelAnnouncements } from "../../chatgpt-session";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

import { readChatGptUsageAccount, supportsChatGptUsageTracking } from "./account";
export { readChatGptUsageAccount, supportsChatGptUsageTracking } from "./account";

/** The authenticated account tier is stable across renamed and translated billing headings. */
export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!supportsChatGptUsageTracking(before)) return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  const after = await readChatGptUsageAccount(page);
  if (after.accountKey !== before.accountKey || after.planType !== before.planType
    || !supportsChatGptUsageTracking(after) || after.needsAttention) {
    throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
  }
  return { accountKey: after.accountKey, plan: after.planType === "pro" ? "pro_200" : "pro_100" };
}

/** Read the selected family from the slider announcement and its active picker header. */
export async function readChatGptUsageModel(slider: Locator, isPro: boolean): Promise<ChatGptUsageModel> {
  if (!isPro) return "other";
  const announcements = await readChatGptModelAnnouncements(slider);
  return chatGptUsageModelFromAnnouncements(announcements);
}

export function chatGptUsageModelFromAnnouncements(announcements: readonly string[]): ChatGptUsageModel {
  const families = new Set<ChatGptUsageModel>();
  for (const text of announcements) {
    if (/^\s*(?:GPT[-\s])?6(?:\s+Astra)?\s+Pro(?:\s|[,.;]|$)/i.test(text)) families.add("gpt-6-pro");
    if (/^\s*(?:GPT[-\s])?5\.6(?:\s+Sol)?\s+Pro(?:\s|[,.;]|$)/i.test(text)) families.add("gpt-5.6-pro");
  }
  return families.size === 1 ? [...families][0]! : "pro-unknown";
}
