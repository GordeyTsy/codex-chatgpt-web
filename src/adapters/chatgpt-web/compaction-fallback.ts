import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ChatGptWebAdapterError } from "./adapter-error";

export const COMPACTION_FILE_COOLDOWN_MS = 3 * 60 * 60 * 1_000;

/** Authentication, owner cancellation, quota and safety denials are never transport fallback. */
export function isCompactionTransportFailure(error: unknown): boolean {
  if (!(error instanceof ChatGptWebAdapterError)) return false;
  return ["chatgpt_model_no_progress", "chatgpt_message_delivery_timeout", "chatgpt_multipart_acknowledgement_timeout",
    "chatgpt_assistant_dom_unavailable", "upstream_server_error", "rate_limit_exceeded", "compaction_handoff_timeout",
    "context_length_exceeded"].includes(error.code);
}

/** Persist only an expiry and failure code, never the task, account data or conversation. */
export class CompactionFallbackPolicy {
  private readonly key: string;
  constructor(private readonly path: string | undefined, scope: string, private readonly now = Date.now) {
    this.key = createHash("sha256").update(scope).digest("hex");
  }
  private read(): Record<string, { until: number; code: string }> {
    if (!this.path || !existsSync(this.path)) return {};
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.version !== 1 || !data.scopes || typeof data.scopes !== "object") return {};
      const scopes: Record<string, { until: number; code: string }> = {};
      for (const [key, entry] of Object.entries(data.scopes) as [string, { until: number; code: string }][]) {
        if (/^[a-f0-9]{64}$/.test(key) && Number.isFinite(entry?.until) && entry.until > this.now()
          && entry.until <= this.now() + COMPACTION_FILE_COOLDOWN_MS && typeof entry.code === "string") scopes[key] = entry;
        if (Object.keys(scopes).length >= 64) break;
      }
      return scopes;
    } catch { return {}; }
  }
  private memoryUntil = 0;
  active(): boolean { return Math.max(this.memoryUntil, this.read()[this.key]?.until ?? 0) > this.now(); }
  activate(error: unknown): number {
    if (!isCompactionTransportFailure(error)) throw new Error("Not a compaction transport failure");
    const existing = Math.max(this.memoryUntil, this.read()[this.key]?.until ?? 0);
    if (existing > this.now()) return existing;
    const until = this.now() + COMPACTION_FILE_COOLDOWN_MS;
    this.memoryUntil = until;
    if (this.path) {
      const scopes = this.read();
      scopes[this.key] = { until, code: (error as ChatGptWebAdapterError).code };
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, scopes }), { mode: 0o600 });
      renameSync(temporary, this.path);
    }
    return until;
  }
}
