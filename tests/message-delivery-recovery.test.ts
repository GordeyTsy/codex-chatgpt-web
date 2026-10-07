import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptMessageDeliveryRecovery } from "../src/adapters/chatgpt-web/message-delivery-recovery";
import { ChatGptBrowserWorker, throwIfChatGptSessionFailureAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptModelProgressWatchdog } from "../src/adapters/chatgpt-web/model-progress-watchdog";

const executablePath = process.env.CHATGPT_DOM_TEST_BROWSER;
const domTest = (name: string, run: () => Promise<void>, timeout = 15_000) =>
  test.skipIf(!executablePath)(name, run, timeout);
const fixture = readFileSync(new URL("./fixtures/chatgpt-delivery-timeout.html", import.meta.url), "utf8");
let browser: Browser;
beforeAll(async () => { if (executablePath) browser = await chromium.launch({ executablePath, headless: true }); });
afterAll(async () => { await browser?.close(); });

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    await page.evaluate(() => {
      (window as any).deliveryRetryCount = 0;
      document.addEventListener("click", event => {
        if ((event.target as HTMLElement).textContent === "Retry") (window as any).deliveryRetryCount++;
      });
    });
    await run(page);
  } finally { await page.close(); }
}

async function acceptRetry(page: Page): Promise<void> {
  await page.locator('aside button').evaluate(button => button.addEventListener("click", () => {
    button.closest("aside")!.remove();
    document.querySelector('[data-markdown-text-style] p')!.textContent += " Resumed progress.";
  }));
}

domTest("delivery Retry resumes the bound exchange without replacing its prior response", async () => {
  await withPage(async page => {
    const scope = page.locator('[data-turn-key="current"]');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const before = await worker.responseDomSnapshot(scope, {});
    expect(before.visibleText).toBe("Preserved progress.");
    await acceptRetry(page);
    expect(await new ChatGptMessageDeliveryRecovery().recover(scope)).toBe("recovered");
    const after = await worker.responseDomSnapshot(scope, {});
    expect(after.visibleText).toBe(before.visibleText + " Resumed progress.");
    expect(await scope.count()).toBe(1);
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(1);
    expect(await new ChatGptMessageDeliveryRecovery().recover(scope)).toBe("none");
  });
});

domTest("standard compaction fails its first confirmed timeout without activating Retry", async () => {
  for (const retryMounted of [true, false]) {
    await withPage(async page => {
      if (!retryMounted) await page.locator("aside button").evaluate(button => button.remove());
      const scope = page.locator('[data-turn-key="current"]');
      const recovery = new ChatGptMessageDeliveryRecovery("fail");
      const first = await recovery.recover(scope).catch(error => error);
      expect(first).toMatchObject({ code: "chatgpt_message_delivery_timeout" });
      expect(await recovery.recover(scope).catch(error => error)).toBe(first);
      expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
      expect(await scope.count()).toBe(1);
    });
  }
});

domTest("standard compaction preserves in-flight tools before switching transport", async () => {
  await withPage(async page => {
    const scope = page.locator('[data-turn-key="current"]');
    const recovery = new ChatGptMessageDeliveryRecovery("fail");
    expect(await recovery.recover(scope, { toolCallsInFlight: true, now: 1 })).toBe("waiting");
    expect(await recovery.recover(scope, { toolCallsInFlight: false, now: 2 }).catch(error => error))
      .toMatchObject({ code: "chatgpt_message_delivery_timeout" });
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
  });
});

domTest("old, hidden and quoted timeout cards never trigger recovery", async () => {
  for (const scenario of ["old", "hidden", "markdown", "user", "other-error"]) {
    await withPage(async page => {
      await page.evaluate(scenario => {
        const card = document.querySelector("aside")!;
        if (scenario === "old") document.querySelector("main")!.insertAdjacentHTML("beforeend", '<div data-turn-key="newer"></div>');
        if (scenario === "hidden") card.setAttribute("hidden", "");
        if (scenario === "markdown") card.parentElement!.setAttribute("data-markdown-text-style", "assistant-message");
        if (scenario === "user") card.parentElement!.setAttribute("data-message-author-role", "user");
        if (scenario === "other-error") card.querySelector("div div")!.textContent = "An unrelated failure.";
      }, scenario);
      for (const mode of ["retry", "fail"] as const) {
        expect(await new ChatGptMessageDeliveryRecovery(mode).recover(page.locator('[data-turn-key="current"]'))).toBe("none");
      }
      expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
    });
  }
});

domTest("background WebContents with zero layout width still exposes a rendered timeout", async () => {
  await withPage(async page => {
    await page.locator("main").evaluate(element => { element.style.width = "0px"; element.style.overflow = "hidden"; });
    await acceptRetry(page);
    expect(await new ChatGptMessageDeliveryRecovery().recover(page.locator('[data-turn-key="current"]'))).toBe("recovered");
  });
});

domTest("active generation and tools must settle before delivery Retry", async () => {
  for (const scenario of ["generation", "tools"]) {
    await withPage(async page => {
      const scope = page.locator('[data-turn-key="current"]');
      const recovery = new ChatGptMessageDeliveryRecovery();
      if (scenario === "generation") await page.locator("main").evaluate(element => {
        element.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>');
      });
      expect(await recovery.recover(scope, { toolCallsInFlight: scenario === "tools", now: 1 })).toBe("waiting");
      expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
      await page.locator('[data-testid="stop-button"]').evaluateAll(elements => elements.forEach(element => element.remove()));
      await acceptRetry(page);
      expect(await recovery.recover(scope, { toolCallsInFlight: false })).toBe("recovered");
    });
  }
});

domTest("stuck generation, tools and disabled Retry return a bounded transport error", async () => {
  for (const scenario of ["generation", "tools", "disabled"]) {
    await withPage(async page => {
      const scope = page.locator('[data-turn-key="current"]');
      const recovery = new ChatGptMessageDeliveryRecovery();
      if (scenario === "generation") await page.locator("main").evaluate(element => {
        element.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>');
      });
      if (scenario === "disabled") await page.locator("aside button").evaluate(element => { (element as HTMLButtonElement).disabled = true; });
      expect(await recovery.recover(scope, { toolCallsInFlight: scenario === "tools", now: 1 })).toBe("waiting");
      expect(await recovery.recover(scope, { toolCallsInFlight: scenario === "tools", now: 90_001 }).catch(error => error)).toMatchObject({
        code: "chatgpt_message_delivery_timeout", retryable: true,
      });
      expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
    });
  }
});

domTest("bridge attempts remain bounded when the same response repeatedly times out", async () => {
  await withPage(async page => {
    const recovery = new ChatGptMessageDeliveryRecovery();
    const scope = page.locator('[data-turn-key="current"]');
    const card = await page.locator("aside").evaluate(element => element.outerHTML);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await scope.evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), card);
      await acceptRetry(page);
      expect(await recovery.recover(scope)).toBe("recovered");
    }
    await scope.evaluate((element, html) => element.insertAdjacentHTML("beforeend", html), card);
    expect(await recovery.recover(scope).catch(error => error)).toMatchObject({
      code: "chatgpt_message_delivery_timeout", message: expect.stringContaining("bounded bridge recovery attempts are exhausted"),
    });
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(3);
  });
});

domTest("missing or ambiguous Retry is an explicit error, never response regeneration", async () => {
  for (const scenario of ["missing", "ambiguous"]) {
    await withPage(async page => {
      await page.locator("aside button").evaluate((element, scenario) => {
        if (scenario === "missing") element.textContent = "Regenerate";
        else element.insertAdjacentHTML("afterend", '<button type="button">Retry</button>');
      }, scenario);
      const recovery = new ChatGptMessageDeliveryRecovery();
      if (scenario === "missing") {
        expect(await recovery.recover(page.locator('[data-turn-key="current"]'), { now: 1 })).toBe("waiting");
        expect(await recovery.recover(page.locator('[data-turn-key="current"]'), { now: 90_001 }).catch(error => error))
          .toMatchObject({ code: "chatgpt_message_delivery_timeout" });
      } else expect(await recovery.recover(page.locator('[data-turn-key="current"]')).catch(error => error))
        .toMatchObject({ message: expect.stringContaining("no unambiguous delivery Retry action") });
      expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
    });
  }
});

domTest("a delivery card may mount before Retry without rebuilding the exchange", async () => {
  await withPage(async page => {
    const scope = page.locator('[data-turn-key="current"]');
    const recovery = new ChatGptMessageDeliveryRecovery();
    await page.locator("aside button").evaluate(button => button.remove());
    expect(await recovery.recover(scope, { now: 1 })).toBe("waiting");
    await page.locator("aside").evaluate(card => card.insertAdjacentHTML("beforeend", '<button type="button">Retry</button>'));
    await acceptRetry(page);
    expect(await recovery.recover(scope, { now: 2 })).toBe("recovered");
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(1);
    expect(await scope.count()).toBe(1);
  });
});

domTest("a near-deadline Retry is not cancelled by the previous model-silence clock", async () => {
  await withPage(async page => {
    const watchdog = new ChatGptModelProgressWatchdog();
    watchdog.start(Date.now() - 299_800);
    await page.locator("aside button").evaluate(button => button.addEventListener("click", () => {
      setTimeout(() => button.closest("aside")!.remove(), 400);
    }));
    const states: string[] = [];
    const pending = new ChatGptMessageDeliveryRecovery().recover(page.locator('[data-turn-key="current"]'), {
      onRetryState: state => {
        states.push(state);
        if (state === "started") watchdog.beginDeliveryRetry();
        else watchdog.endDeliveryRetry(state === "submitted");
      },
    });
    await page.waitForFunction(() => (window as any).deliveryRetryCount === 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(watchdog.failure()).toBeUndefined();
    expect(await pending).toBe("recovered");
    expect(states).toEqual(["started", "submitted"]);
    expect(watchdog.failure()).toBeUndefined();
    expect(watchdog.outputCount).toBe(0);
  });
});

domTest("Retry before the first assistant waits for hydration and preserves the accepted exchange", async () => {
  await withPage(async page => {
    await page.setContent('<main></main>');
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { modelProgressTimeoutMs: 300_000 },
    }) as any;
    const baseline = await worker.captureSubmissionBaseline(page, "Summarize saved context.");
    await page.locator('main').evaluate(main => {
      main.innerHTML = '<div data-turn-key="accepted"><div data-user-message-bubble>Summarize saved context.</div>'
        + '<aside role="alert"><div>Message delivery timed out. Please try again.</div></aside></div>';
      setTimeout(() => {
        const card = document.querySelector('aside')!;
        const button = document.createElement('button'); button.textContent = 'Retry';
        button.addEventListener('click', () => {
          (window as any).deliveryRetryCount++;
          card.remove();
          document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
          setTimeout(() => document.querySelector('[data-turn-key="accepted"]')!.insertAdjacentHTML('beforeend',
            '<div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message">Actual summary.</div>'), 600);
        });
        card.append(button);
      }, 400);
    });
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    const watchdog = new ChatGptModelProgressWatchdog(); watchdog.start(Date.now() - 299_800);
    const states: string[] = [];
    const pending = worker.waitForNewAssistantTurn(page, baseline, undefined, undefined, undefined, 100, undefined, undefined, {
      recovery: new ChatGptMessageDeliveryRecovery(),
      onRetryState: (state: string) => {
        states.push(state);
        if (state === "waiting") watchdog.waitForDeliveryRetry();
        else if (state === "started") watchdog.beginDeliveryRetry();
        else watchdog.endDeliveryRetry(state === "submitted");
      },
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(watchdog.failure()).toBeUndefined();
    const binding = await pending;
    expect(binding.identity).toBe("group:assistant:accepted");
    expect(states).toEqual(["waiting", "started", "submitted"]);
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(1);
    expect(watchdog.failure()).toBeUndefined();
    expect(watchdog.outputCount).toBe(0);
    expect(await page.locator('[data-turn-key]').count()).toBe(1);
  });
});

domTest("cancellation before or during recovery never sends an extra Retry", async () => {
  await withPage(async page => {
    const controller = new AbortController(); controller.abort();
    expect(await new ChatGptMessageDeliveryRecovery().recover(page.locator('[data-turn-key="current"]'), { signal: controller.signal }).catch(error => error))
      .toMatchObject({ name: "AbortError" });
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(0);
  });
  await withPage(async page => {
    const controller = new AbortController();
    const pending = new ChatGptMessageDeliveryRecovery().recover(page.locator('[data-turn-key="current"]'), { signal: controller.signal }).catch(error => error);
    await page.waitForFunction(() => (window as any).deliveryRetryCount === 1);
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(1);
  });
});

domTest("an unconfirmed Retry is not activated again on the same recovery object", async () => {
  await withPage(async page => {
    const recovery = new ChatGptMessageDeliveryRecovery();
    const scope = page.locator('[data-turn-key="current"]');
    const first = await recovery.recover(scope).catch(error => error);
    expect(first.message).toContain("Retry could not be confirmed");
    const second = await recovery.recover(scope).catch(error => error);
    expect(second).toBe(first);
    expect(second.message).toContain("Retry could not be confirmed");
    expect(await page.evaluate(() => (window as any).deliveryRetryCount)).toBe(1);
  });
}, 30_000);


domTest("an anonymous composer with rendered login controls is an authentication gate", async () => {
  await withPage(async page => {
    await page.setContent('<header><button>Log in</button><button>Sign up for free</button></header><main><div id="prompt-textarea" contenteditable="true"></div></main>');
    await expect(throwIfChatGptSessionFailureAlert(page)).rejects.toMatchObject({
      code: "chatgpt_sign_in_required", status: 401, retryable: false,
    });
  });
});

domTest("preparation classifies logout before attempting an unavailable editor", async () => {
  await withPage(async page => {
    await page.route("https://chatgpt.com/**", route => route.fulfill({
      contentType: "text/html", body: '<header><button>Log in</button><button>Sign up for free</button></header>',
    }));
    await page.goto("https://chatgpt.com/?temporary-chat=true");
    let editorReads = 0;
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => { editorReads++; throw new Error("editor unavailable"); },
    });
    await expect(worker.prepareChatSurface(page)).rejects.toMatchObject({
      code: "chatgpt_sign_in_required", status: 401,
    });
    expect(editorReads).toBe(0);
  });
});

domTest("logout controls appearing during editor hydration stop preparation promptly", async () => {
  await withPage(async page => {
    await page.route("https://chatgpt.com/**", route => route.fulfill({
      contentType: "text/html", body: '<main>Loading</main>',
    }));
    await page.goto("https://chatgpt.com/?temporary-chat=true");
    const worker = Object.create(ChatGptBrowserWorker.prototype);
    const pending = worker.prepareChatSurface(page);
    await page.evaluate(() => setTimeout(() => {
      document.body.innerHTML = '<header><button>Log in</button><button>Sign up</button></header>';
    }, 100));
    await expect(pending).rejects.toMatchObject({ code: "chatgpt_sign_in_required", status: 401 });
  });
}, 8_000);

domTest("quoted, hidden and partial login controls never classify an authenticated page as logged out", async () => {
  for (const content of [
    '<div data-message-author-role="assistant"><button>Log in</button><button>Sign up for free</button></div>',
    '<header hidden><button>Log in</button><button>Sign up</button></header>',
    '<header><button>Log in</button></header>',
    '<pre><button>Log in</button><button>Sign up</button></pre>',
  ]) await withPage(async page => {
    await page.setContent(content + '<div id="prompt-textarea" contenteditable="true"></div>');
    await expect(throwIfChatGptSessionFailureAlert(page)).resolves.toBeUndefined();
  });
});
