import { ChatGptWebAdapterError } from "./adapter-error";

const inability = /^(?:I (?:could not|cannot|was unable to)|Unable to|Не (?:смог|могу)|Не удалось|Codex (?:Native|bridge).{0,80}(?:failed|rejected))/i;

/** A terminal inability report, not a quoted error in a successful explanation. */
export function isChatGptBindingFailureReport(text: string): boolean {
  const plain = text.trim().replace(/[*_`]/g, "");
  return inability.test(plain)
    && /turn[ _]?token (?:is invalid, expired, or revoked|was issued for [^\n]{1,180}which has already finished)/i.test(plain);
}

export function assertChatGptBindingCompletion(text: string): void {
  if (!isChatGptBindingFailureReport(text)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT stopped because it supplied an unusable turn token. Preserve the current logical turn "
    + "and its completed results; rebuild the browser context with the exact owner-issued token. "
    + "The rejected call was not executed and must not be remapped to another capability.",
    { status: 502, errorType: "server_error", code: "chatgpt_turn_token_mismatch", retryable: true },
  );
}

/** Hold a short answer prefix so a binding failure cannot become a native final answer. */
export class ChatGptBindingAnswerBuffer {
  private pending = "";
  private streamed = false;

  observe(delta: string): string {
    if (this.streamed) return delta;
    this.pending += delta;
    const plain = this.pending.trim().replace(/[*_`]/g, "");
    if (this.pending.length < 1024 || inability.test(plain)) return "";
    this.streamed = true;
    const result = this.pending;
    this.pending = "";
    return result;
  }

  finish(): string {
    const result = this.pending;
    this.pending = "";
    return result;
  }
}
