import { expect, test } from "bun:test";
import { assertChatGptBindingCompletion, ChatGptBindingAnswerBuffer, isChatGptBindingFailureReport } from "../src/adapters/chatgpt-web/binding-failure";

const failure = "Не смог продолжить выполнение I1: Codex bridge отклонил первый же нативный вызов с ошибкой **turn token is invalid, expired, or revoked**. Попытка зарегистрировать ошибку также отклонена.";

test.each([failure, "I could not continue: turn token is invalid, expired, or revoked.",
  "Unable to continue. This turn_token was issued for turn example, which has already finished. This action can no longer run."])("terminal capability failure remains recoverable before the completion fence: %s", text => {
  expect(isChatGptBindingFailureReport(text)).toBeTrue();
  expect(() => assertChatGptBindingCompletion(text)).toThrow();
  try { assertChatGptBindingCompletion(text); } catch (error: any) {
    expect(error.code).toBe("chatgpt_turn_token_mismatch"); expect(error.retryable).toBeTrue();
  }
});

test.each(["The diagnosed error was 'turn token is invalid, expired, or revoked'; it is now fixed.",
  "I cannot explain a token mismatch without logs. The source check completed.",
  "Unable to continue: approval required.", "Unable to continue: session expired, please sign in.",
  "Work completed. Example: I cannot continue: turn token is invalid, expired, or revoked."])("ordinary explanations, policy and authentication do not become token retries: %s", text => {
  expect(isChatGptBindingFailureReport(text)).toBeFalse(); expect(() => assertChatGptBindingCompletion(text)).not.toThrow();
});

test("a fragmented short failure emits no final text before diagnosis", () => {
  const buffer = new ChatGptBindingAnswerBuffer();
  for (const delta of failure.match(/.{1,7}/g)!) expect(buffer.observe(delta)).toBe("");
  expect(() => assertChatGptBindingCompletion(failure)).toThrow();
});

test("ordinary short and long answers preserve their exact bytes", () => {
  for (const answer of ["Verified.", "Evidence: " + "x".repeat(3000)]) {
    const buffer = new ChatGptBindingAnswerBuffer(); let emitted = "";
    for (const delta of answer.match(/.{1,17}/g)!) emitted += buffer.observe(delta);
    assertChatGptBindingCompletion(answer); emitted += buffer.finish(); expect(emitted).toBe(answer);
  }
});
