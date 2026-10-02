import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { captureChatGptTimeoutPage } from "../src/adapters/chatgpt-web/timeout-page-snapshot";

test("timeout evidence saves private page artifacts without exporting their contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-timeout-page-"));
  try {
    const stem = join(directory, "trace-timeout");
    const page = { screenshot: async () => Buffer.from("png fixture"),
      evaluate: async () => ({ html: "<div role='alert'>Delivery failed</div>",
        text: "Delivery failed", htmlTruncated: false, textTruncated: false }) } as unknown as Page;
    await captureChatGptTimeoutPage(page, stem);
    expect(readFileSync(`${stem}.txt`, "utf8")).toBe("Delivery failed");
    expect(readFileSync(`${stem}.html`, "utf8")).toContain("role='alert'");
    expect(JSON.parse(readFileSync(`${stem}.capture.json`, "utf8"))).toMatchObject({
      reason: "chatgpt_model_no_progress", saved: ["png", "html", "txt", "page.json"], failed: [],
    });
    if (process.platform !== "win32") for (const name of readdirSync(directory)) {
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("closed or broken page records partial capture and permits cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-timeout-partial-"));
  try {
    const stem = join(directory, "trace-timeout");
    const page = { screenshot: async () => { throw new Error("closed"); },
      evaluate: async () => { throw new Error("unresponsive"); } } as unknown as Page;
    await captureChatGptTimeoutPage(page, stem);
    expect(JSON.parse(readFileSync(`${stem}.capture.json`, "utf8"))).toMatchObject({ saved: [], failed: ["screenshot", "page"] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
