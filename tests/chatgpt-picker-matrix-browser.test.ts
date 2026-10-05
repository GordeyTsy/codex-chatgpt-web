import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";

const executablePath = process.env.CHATGPT_DOM_TEST_BROWSER;
let browser: Browser;
beforeAll(async () => { if (executablePath) browser = await chromium.launch({ executablePath, headless: true }); });
afterAll(async () => { await browser?.close(); });
const fixture = readFileSync(new URL("./fixtures/chatgpt-model-picker.html", import.meta.url), "utf8");
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
const domTest = (name: string, run: () => Promise<void>) => test.skipIf(!executablePath)(name, run, 15_000);

async function withPicker(options: Record<string, unknown>, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  try {
    await page.setContent(`<script>window.pickerConfig=${JSON.stringify(options)}</script>` + fixture);
    await run(page);
  } finally { await page.close(); }
}

// Public routes provide six valid targets. Latest's four lower levels are also used by
// multipart staging. Check both families and every starting slider position for all ten.
for (const fromFamily of ["5.6", "6"] as const)
for (let fromValue = 0; fromValue < efforts.length; fromValue++)
for (const family of ["5.6", "6"] as const)
for (const effort of efforts) {
  domTest(`${fromFamily}/${efforts[fromValue]} → ${family}/${effort}`, async () => {
    await withPicker({ family: fromFamily, value: fromValue, versioned: fromValue % 2 === 0 }, async page => {
      const mode = await worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, capabilities, undefined, true, family);
      await worker.assertSelectedEffort(page, mode);
      expect(mode).toMatchObject({ effort, modelFamily: family, uiEffortIndex: efforts.indexOf(effort) });
      expect(mode.usageModel).toBe(effort === "max" ? family === "6" ? "gpt-6-pro" : "gpt-5.6-pro" : "other");
      expect(await page.locator("#prompt-textarea").innerText()).toBe("Preserved draft 😀");
      expect(await page.locator("button").getAttribute("aria-expanded")).toBe("false");
      const actions = await page.evaluate(() => (window as any).pickerActions as string[]);
      expect(actions.filter(action => action.startsWith("select-family:"))).toEqual(fromFamily === family ? [] : [`select-family:${family}`]);
    });
  });
}

domTest("the matrix includes every supported named model/effort route", async () => {
  const publicTargets = CHATGPT_WEB_MODEL_ROUTES.flatMap(route => (route.supportedCodexEfforts ?? [route.codexEffort]).map(effort => `${route.modelFamily}/${effort}`));
  expect(publicTargets).toEqual(["5.6/low", "5.6/medium", "5.6/high", "5.6/xhigh", "5.6/max", "6/max"]);
});

for (const family of ["5.6", "6"] as const) {
  for (const alreadySelected of [false, true]) domTest(`direct model list ${family}, already selected=${alreadySelected}`, async () => {
    await withPicker({ family: alreadySelected ? family : family === "5.6" ? "6" : "5.6", value: 3, direct: true }, async page => {
      expect(await worker.selectModelAndEffort(page, "gpt-5.6-sol", "max", capabilities, undefined, true, family))
        .toMatchObject({ effort: "max", usageModel: family === "6" ? "gpt-6-pro" : "gpt-5.6-pro" });
    });
  });
  domTest(`selection survives closing on family change: ${family}`, async () => {
    await withPicker({ family: family === "5.6" ? "6" : "5.6", value: 0, closeOnFamily: true }, async page => {
      expect(await worker.selectModelAndEffort(page, "gpt-5.6-sol", "max", capabilities, undefined, true, family))
        .toMatchObject({ effort: "max", usageModel: family === "6" ? "gpt-6-pro" : "gpt-5.6-pro" });
    });
  });
  domTest(`nonzero slider range retains requested family and effort: ${family}`, async () => {
    await withPicker({ family: family === "5.6" ? "6" : "5.6", value: 1, min: 3 }, async page => {
      expect(await worker.selectModelAndEffort(page, "gpt-5.6-sol", "xhigh", capabilities, undefined, false, family))
        .toMatchObject({ effort: "xhigh", modelFamily: family });
    });
  });
}

domTest("a visible but inert family row cannot skip the active model-list trigger", async () => {
  await withPicker({ family: "6", value: 3 }, async page => {
    await page.locator("button").click();
    expect(await page.getByRole("menuitemradio", { name: "GPT-5.6 Sol", includeHidden: true }).isVisible()).toBe(true);
    const mode = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "xhigh", capabilities, undefined, false, "5.6");
    expect(mode.modelFamily).toBe("5.6");
    expect(await page.evaluate(() => (window as any).pickerActions)).toContain("open-models");
  });
});

domTest("a family click that did not change the selected radio is rejected", async () => {
  await withPicker({ family: "6", value: 3, ignoreFamily: true }, async page => {
    const error = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "xhigh", capabilities, undefined, false, "5.6")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "model_version_unavailable", retryable: false });
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Preserved draft 😀");
  });
});

domTest("a slider that jumps over the requested step is rejected", async () => {
  await withPicker({ family: "5.6", value: 0, jump: 2 }, async page => {
    const error = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "medium", capabilities, undefined, false, "5.6")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("did not move exactly one step") }) });
  });
});
