import type { Page } from "playwright-core";
import { atomicWriteFile } from "../../config";

/** Private local evidence only. Capture failures must never prevent turn cleanup. */
export async function captureChatGptTimeoutPage(page: Page, stem: string,
  reason: "chatgpt_model_no_progress" | "chatgpt_assistant_dom_unavailable" | "chatgpt_multipart_acknowledgement_timeout" = "chatgpt_model_no_progress",
): Promise<void> {
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout page capture exceeded 5 seconds")), 5_000);
      })]);
    } finally { clearTimeout(timer!); }
  };
  const results = await Promise.allSettled([
    bounded(page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })),
    bounded(page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      // Preserve visible errors and structure, not script state, cookies or form secrets.
      clone.querySelectorAll("script, input, textarea, [contenteditable='true']").forEach(node => node.remove());
      const limit = 2 * 1024 * 1024;
      const html = clone.outerHTML;
      const text = document.body?.innerText ?? "";
      return { html: html.slice(0, limit), text: text.slice(0, limit),
        htmlTruncated: html.length > limit, textTruncated: text.length > limit };
    })),
  ]);
  const saved: string[] = [];
  const failed: string[] = [];
  for (const [index, result] of results.entries()) {
    const kind = index === 0 ? "screenshot" : "page";
    if (result.status === "rejected") { failed.push(kind); continue; }
    try {
      if (index === 0) {
        atomicWriteFile(`${stem}.png`, result.value as Buffer); saved.push("png");
      } else {
        const state = result.value as { html: string; text: string; htmlTruncated: boolean; textTruncated: boolean };
        atomicWriteFile(`${stem}.html`, state.html); saved.push("html");
        atomicWriteFile(`${stem}.txt`, state.text); saved.push("txt");
        atomicWriteFile(`${stem}.page.json`, JSON.stringify({
          htmlTruncated: state.htmlTruncated, textTruncated: state.textTruncated,
        })); saved.push("page.json");
      }
    } catch { failed.push(kind); }
  }
  atomicWriteFile(`${stem}.capture.json`, JSON.stringify({ version: 1,
    capturedAt: new Date().toISOString(), reason, saved, failed }));
}
