import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

export const DEFAULT_CHATGPT_MODEL_PROGRESS_TIMEOUT_MS = 5 * 60_000;

/** Measures model output and completed tool work, never transport keep-alives. */
export class ChatGptModelProgressWatchdog {
  private lastProgressAt?: number;
  private outputs = 0;

  get outputCount(): number { return this.outputs; }

  constructor(readonly timeoutMs = DEFAULT_CHATGPT_MODEL_PROGRESS_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("ChatGPT modelProgressTimeoutMs must be a positive finite number");
    }
  }

  /** Arm only after the browser has actually accepted the submission. */
  start(now = Date.now()): void {
    this.lastProgressAt ??= now;
  }

  recordOutput(delta: string, now = Date.now()): void {
    if (this.lastProgressAt !== undefined && delta.length > 0) {
      this.outputs++;
      this.lastProgressAt = Math.max(this.lastProgressAt, now);
    }
  }

  inactivityMs(progress?: ChatGptExternalTurnProgressSnapshot, now = Date.now()): number | undefined {
    if (this.lastProgressAt === undefined) return undefined;
    if (progress?.lastProgressAt !== undefined) {
      // The recorder stamps actual requests/results. Repeated snapshots and
      // retirement revisions do not create a new activity timestamp.
      this.lastProgressAt = Math.max(this.lastProgressAt, progress.lastProgressAt);
    }
    if ((progress?.activeToolCalls ?? 0) > 0) return undefined;
    return Math.max(0, now - this.lastProgressAt);
  }

  failure(progress?: ChatGptExternalTurnProgressSnapshot, now = Date.now()): ChatGptWebAdapterError | undefined {
    const inactivityMs = this.inactivityMs(progress, now);
    if (inactivityMs === undefined || inactivityMs < this.timeoutMs) return undefined;
    return new ChatGptWebAdapterError(
      `ChatGPT model made no progress for ${this.timeoutMs / 1_000} seconds after submission or the last tool result. `
      + "Resume unfinished work from the preserved Codex history in a fresh browser conversation.",
      { status: 502, errorType: "server_error", code: "chatgpt_model_no_progress", retryable: true },
    );
  }
}
