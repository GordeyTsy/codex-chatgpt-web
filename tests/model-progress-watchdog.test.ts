import { describe, expect, test } from "bun:test";
import { ChatGptModelProgressWatchdog, DEFAULT_CHATGPT_MODEL_PROGRESS_TIMEOUT_MS } from "../src/adapters/chatgpt-web/model-progress-watchdog";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

describe("real model progress watchdog", () => {
  test("default is five minutes; submission, not setup, arms the exact boundary", () => {
    const watchdog = new ChatGptModelProgressWatchdog();
    expect(DEFAULT_CHATGPT_MODEL_PROGRESS_TIMEOUT_MS).toBe(300_000);
    expect(watchdog.failure(undefined, 900_000)).toBeUndefined();
    watchdog.start(1_000);
    watchdog.start(999_999); // repeated submission evidence cannot prolong a stall
    expect(watchdog.failure(undefined, 300_999)).toBeUndefined();
    expect(watchdog.failure(undefined, 301_000)).toMatchObject({
      code: "chatgpt_model_no_progress", status: 502, retryable: true,
    });
  });
  test("new text resets the clock; empty output and repeated progress snapshots do not", () => {
    const watchdog = new ChatGptModelProgressWatchdog(300);
    const progress = new ChatGptExternalTurnProgress();
    watchdog.start(0);
    watchdog.recordOutput("new visible commentary", 250);
    watchdog.recordOutput("", 500);
    expect(watchdog.failure(progress.snapshot(), 549)).toBeUndefined();
    expect(watchdog.failure(progress.snapshot(), 550)?.code).toBe("chatgpt_model_no_progress");
  });
  test("parallel long tools suspend the budget until the last returned result", () => {
    const watchdog = new ChatGptModelProgressWatchdog(300);
    const progress = new ChatGptExternalTurnProgress();
    watchdog.start(0);
    progress.recordToolBatch(2, 10);
    expect(watchdog.failure(progress.snapshot(), 100_000)).toBeUndefined();
    progress.recordToolResult(100_100);
    expect(watchdog.failure(progress.snapshot(), 200_000)).toBeUndefined();
    progress.recordToolResult(200_100);
    expect(watchdog.failure(progress.snapshot(), 200_399)).toBeUndefined();
    expect(watchdog.failure(progress.snapshot(), 200_400)?.code).toBe("chatgpt_model_no_progress");
  });
  test("retirement revisions do not invent new model activity", () => {
    const watchdog = new ChatGptModelProgressWatchdog(300);
    const progress = new ChatGptExternalTurnProgress();
    watchdog.start(0); progress.recordToolBatch(1, 5); progress.recordToolResult(10);
    expect(watchdog.failure(progress.snapshot(), 309)).toBeUndefined();
    progress.retire(new Error("retired"));
    expect(watchdog.failure(progress.snapshot(), 310)?.code).toBe("chatgpt_model_no_progress");
  });
  test.each([0, -1, NaN, Infinity])("rejects invalid timeout %s", timeout => {
    expect(() => new ChatGptModelProgressWatchdog(timeout)).toThrow("positive finite");
  });
});
