import type { CustomAction } from "./turn-broker";

export const SAFETY_FALLBACK_START_TAG = "<<<CODEX_SAFETY_FALLBACK>>>";
export const SAFETY_FALLBACK_END_TAG = "<<<END_CODEX_SAFETY_FALLBACK>>>";
export const ALT_SAFETY_FALLBACK_START_TAG = "[CODEX_SAFETY_FALLBACK]";
export const ALT_SAFETY_FALLBACK_END_TAG = "[/CODEX_SAFETY_FALLBACK]";

const FALLBACK_START_PATTERN = /(?:<<<CODEX_SAFETY_FALLBACK>>>|\[CODEX_SAFETY_FALLBACK\])/i;
const FALLBACK_END_PATTERN = /(?:<<<END_CODEX_SAFETY_FALLBACK>>>|\[\/CODEX_SAFETY_FALLBACK\])/i;
const FALLBACK_PREFIX_PATTERN = /(?:<<<CODEX_SAFETY_FALLBACK|\[CODEX_SAFETY_FALLBACK)/i;

export function hasSafetyFallbackMarker(text: string): boolean {
  return FALLBACK_PREFIX_PATTERN.test(text);
}

export function stripSafetyFallback(text: string): string {
  const match = FALLBACK_PREFIX_PATTERN.exec(text);
  if (!match) return text;
  return text.slice(0, match.index).trimEnd();
}

export function customActionFromFallbackPayload(
  failedTool: string,
  raw: Record<string, unknown>,
  command?: string,
  argSummary?: string,
  args?: Record<string, unknown>,
): CustomAction | undefined {
  if (failedTool === "codex_exec") {
    const cmd = command
      || (typeof raw.cmd === "string" ? raw.cmd : undefined)
      || (typeof args?.cmd === "string" ? args.cmd : undefined)
      || argSummary;
    if (cmd && cmd.trim().length > 0) return { tool: "codex_exec", command: cmd };
  } else if (failedTool === "codex_apply_patch") {
    const patch = (typeof raw.patch === "string" ? raw.patch : undefined)
      || (typeof args?.patch === "string" ? args.patch : undefined)
      || command
      || argSummary;
    if (patch && patch.trim().length > 0) return { tool: "codex_apply_patch", patch };
  } else if (failedTool === "codex_tool_call") {
    const wireName = (typeof raw.wire_name === "string" ? raw.wire_name : undefined)
      || (typeof args?.wire_name === "string" ? args.wire_name : undefined);
    if (wireName) {
      const toolArgs = raw.tool_arguments && typeof raw.tool_arguments === "object" && !Array.isArray(raw.tool_arguments)
        ? raw.tool_arguments as Record<string, unknown>
        : (args ?? {});
      const inputStr = typeof raw.input === "string" ? raw.input : undefined;
      return { tool: "codex_tool_call", wireName, arguments: toolArgs, input: inputStr };
    }
    if (command && command.trim().length > 0) {
      return { tool: "codex_exec", command };
    }
  } else if (failedTool === "codex_write_stdin") {
    const sessionId = typeof raw.session_id === "number"
      ? raw.session_id
      : (typeof args?.session_id === "number" ? args.session_id : undefined);
    if (sessionId !== undefined) {
      const chars = typeof raw.chars === "string"
        ? raw.chars
        : (typeof args?.chars === "string" ? args.chars : undefined);
      const yieldTimeMs = typeof raw.yield_time_ms === "number"
        ? raw.yield_time_ms
        : (typeof args?.yield_time_ms === "number" ? args.yield_time_ms : undefined);
      const maxOutputTokens = typeof raw.max_output_tokens === "number"
        ? raw.max_output_tokens
        : (typeof args?.max_output_tokens === "number" ? args.max_output_tokens : undefined);
      return { tool: "codex_write_stdin", sessionId, chars, yieldTimeMs, maxOutputTokens };
    }
  } else if (failedTool === "codex_view_image") {
    const path = typeof raw.path === "string"
      ? raw.path
      : (typeof args?.path === "string" ? args.path : (command || argSummary));
    if (path && path.trim().length > 0) {
      const detail = raw.detail === "original" || args?.detail === "original" ? "original" : "high";
      return { tool: "codex_view_image", path, detail };
    }
  } else if (failedTool === "codex_tool_inventory") {
    const query = typeof raw.query === "string"
      ? raw.query
      : (typeof args?.query === "string" ? args.query : (command || argSummary));
    return { tool: "codex_tool_inventory", query };
  } else {
    // If unknown tool or unspecified, default to codex_exec if command is present
    const cmd = command || (typeof raw.cmd === "string" ? raw.cmd : undefined) || argSummary;
    if (cmd && cmd.trim().length > 0) return { tool: "codex_exec", command: cmd };
  }
  return undefined;
}

export function parseSafetyFallbackBlock(text: string): { action: CustomAction; rawBlock: string } | undefined {
  const match = FALLBACK_START_PATTERN.exec(text);
  if (!match) return undefined;

  const afterStart = text.slice(match.index + match[0].length);
  const endMatch = FALLBACK_END_PATTERN.exec(afterStart);

  let jsonStr = "";
  let rawBlock = "";

  if (endMatch) {
    jsonStr = afterStart.slice(0, endMatch.index).trim();
    rawBlock = text.slice(match.index, match.index + match[0].length + endMatch.index + endMatch[0].length);
  } else {
    // End tag has not appeared yet, attempt to find balanced JSON object {...}
    const firstBrace = afterStart.indexOf("{");
    if (firstBrace === -1) return undefined;
    const lastBrace = afterStart.lastIndexOf("}");
    if (lastBrace === -1 || lastBrace <= firstBrace) return undefined;
    jsonStr = afterStart.slice(firstBrace, lastBrace + 1).trim();
    rawBlock = text.slice(match.index, match.index + match[0].length + lastBrace + 1);
  }

  // Strip markdown code fences if wrapped in ```json ... ```
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const failedTool = typeof parsed.failed_tool === "string" ? parsed.failed_tool : "codex_exec";
    const command = typeof parsed.command === "string" ? parsed.command : undefined;
    const argSummary = typeof parsed.argument_summary === "string" ? parsed.argument_summary : undefined;
    const rawArgs = parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
      ? parsed.arguments as Record<string, unknown>
      : undefined;

    const action = customActionFromFallbackPayload(failedTool, parsed, command, argSummary, rawArgs);
    if (!action) return undefined;
    return { action, rawBlock };
  } catch {
    return undefined;
  }
}

export class SafetyFallbackStreamDetector {
  private buffer = "";
  private triggered = false;
  private readonly onTrigger: (action: CustomAction, reason: string) => void;

  constructor(onTrigger: (action: CustomAction, reason: string) => void) {
    this.onTrigger = onTrigger;
  }

  observe(chunk: string): { cleanChunk: string; triggered: boolean } {
    if (this.triggered) {
      return { cleanChunk: "", triggered: true };
    }

    this.buffer += chunk;

    if (!hasSafetyFallbackMarker(this.buffer)) {
      return { cleanChunk: chunk, triggered: false };
    }

    // A fallback marker exists in the buffer!
    const parsed = parseSafetyFallbackBlock(this.buffer);
    if (parsed) {
      this.triggered = true;
      console.info(`[chatgpt-web] SafetyFallbackStreamDetector matched fallback block: tool=${parsed.action.tool}`);
      this.onTrigger(parsed.action, "text_fallback_detected");
      return { cleanChunk: "", triggered: true };
    }

    // A marker exists but JSON is still incomplete
    // Suppress passing the tag and incomplete JSON forward
    return { cleanChunk: stripSafetyFallback(chunk), triggered: false };
  }

  isTriggered(): boolean {
    return this.triggered;
  }

  reset(): void {
    this.buffer = "";
    this.triggered = false;
  }
}
