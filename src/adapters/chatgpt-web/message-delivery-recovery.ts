import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";
import { CHATGPT_STOP_BUTTON_SELECTOR } from "../../chatgpt-session";
import { MAX_CHATGPT_WEB_TURN_RETRIES } from "./retry-policy";

const RECOVERY_SETTLE_MS = 20_000;
const TOOL_SETTLE_MS = 90_000;

function deliveryTimeoutError(detail: string, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT message delivery timed out for the current response. ${detail}`,
    { status: 502, errorType: "server_error", code: "chatgpt_message_delivery_timeout", retryable: true, cause },
  );
}

// Electron may give a background WebContents zero layout width. Use the same rendered-DOM
// definition as response extraction, rather than treating that as a hidden error card.
async function rendered(locator: Locator): Promise<boolean> {
  if (!await locator.count()) return false;
  return locator.evaluate(element => {
    if (!element.isConnected) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute("hidden") || style.display === "none"
        || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  }, undefined, { timeout: 2_000 });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
}

/** Only recover the observed delivery-error card in the currently bound exchange.
 * Keep the physical conversation, native turn, tool capability and execution journal intact.
 * This presses the card's delivery Retry action, not the response regeneration action.
 */
export class ChatGptMessageDeliveryRecovery {
  private attempts = 0;
  private waitingSince?: number;
  private failed?: ChatGptWebAdapterError;

  private wait(now: number): "waiting" {
    this.waitingSince ??= now;
    if (now - this.waitingSince >= TOOL_SETTLE_MS) {
      throw deliveryTimeoutError("The pending generation, tool result or Retry action did not settle; reconcile it before continuing.");
    }
    return "waiting";
  }

  async recover(scope: Locator, options: {
    signal?: AbortSignal;
    toolCallsInFlight?: boolean;
    now?: number;
  } = {}): Promise<"none" | "waiting" | "recovered"> {
    checkAbort(options.signal);
    if (this.failed) throw this.failed;
    const alert = scope.locator('aside[role="alert"]')
      .filter({ hasText: /Message delivery timed out\.\s*Please try again\./i }).last();
    if (!await rendered(alert)) {
      this.waitingSince = undefined;
      return "none";
    }
    const issuedByUi = await alert.evaluate(element => {
      // Quoted Markdown, a user message and embedded tool content are not UI failure evidence.
      if (element.closest('[data-markdown-text-style], .markdown, [data-user-message-bubble], [data-message-author-role="user"]')) return false;
      return [...element.querySelectorAll("div, p")]
        .some(node => /^Message delivery timed out\.\s*Please try again\.$/i.test(node.textContent?.trim() ?? ""));
    });
    if (!issuedByUi) return "none";
    // Refuse an old exchange left behind after a newer user submission.
    const current = await scope.evaluate(element => {
      const group = element.closest("[data-turn-key]");
      return !group || [...document.querySelectorAll("[data-turn-key]")].at(-1) === group;
    });
    if (!current) return "none";
    const running = await rendered(scope.page().locator(CHATGPT_STOP_BUTTON_SELECTOR).last());
    if (running || options.toolCallsInFlight) {
      return this.wait(options.now ?? Date.now());
    }
    if (this.attempts >= MAX_CHATGPT_WEB_TURN_RETRIES) {
      throw deliveryTimeoutError("The bounded bridge recovery attempts are exhausted; continue only unfinished work.");
    }
    const retry = alert.getByRole("button", { name: "Retry", exact: true });
    if (await retry.count() !== 1 || !await rendered(retry)) {
      throw deliveryTimeoutError("The current card has no unambiguous delivery Retry action.");
    }
    if (await retry.isDisabled()) return this.wait(options.now ?? Date.now());
    this.waitingSince = undefined;
    checkAbort(options.signal);
    this.attempts += 1; // Reserve before activating an action whose result could be uncertain.
    try {
      await retry.press("Enter", { timeout: 5_000 });
      const deadline = Date.now() + RECOVERY_SETTLE_MS;
      while (await rendered(alert)) {
        checkAbort(options.signal);
        if (Date.now() >= deadline) throw new Error("Delivery Retry did not dismiss the current error card");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      this.failed = deliveryTimeoutError("Delivery Retry could not be confirmed; reconcile before retrying.", error);
      throw this.failed;
    }
    console.info(`[chatgpt-web] message delivery recovery attempt=${this.attempts}`);
    return "recovered";
  }
}
