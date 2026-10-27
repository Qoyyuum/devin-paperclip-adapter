/**
 * UI parser for devin_local run transcripts.
 *
 * Self-contained and browser-safe: no imports, no DOM, no Node APIs, no
 * side effects. The adapter emits every stdout line as a `devin.*` JSON
 * event; this module maps those events onto transcript entries.
 *
 * Contract: paperclip.adapterUiParser 1.0.0
 *
 * @module
 */

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | {
      kind: "result";
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }

  const event = asRecord(parsed);
  const eventType = asText(event?.type);
  if (!event || !eventType.startsWith("devin.")) {
    return [{ kind: "stdout", ts, text: line }];
  }

  switch (eventType) {
    case "devin.init":
      return [{
        kind: "init",
        ts,
        model: asText(event.model),
        sessionId: asText(event.sessionId),
      }];
    case "devin.status": {
      const status = asText(event.status);
      const message = asText(event.message);
      return [{ kind: "system", ts, text: message ? `[${status}] ${message}` : status }];
    }
    case "devin.assistant":
      return [{ kind: "assistant", ts, text: asText(event.text), delta: true }];
    case "devin.thinking":
      return [{ kind: "thinking", ts, text: asText(event.text), delta: true }];
    case "devin.tool_call": {
      const toolCallId = asText(event.toolCallId);
      return [{
        kind: "tool_call",
        ts,
        name: asText(event.title) || asText(event.name) || "tool",
        input: event.input ?? null,
        ...(toolCallId ? { toolUseId: toolCallId } : {}),
      }];
    }
    case "devin.tool_result": {
      const toolCallId = asText(event.toolCallId);
      const status = asText(event.status);
      const content = asText(event.content);
      const isError = event.isError === true || status === "failed";
      return [{
        kind: "tool_result",
        ts,
        toolUseId: toolCallId,
        content: content || (status ? `tool call ${status}` : ""),
        isError,
      }];
    }
    case "devin.plan": {
      const entries = Array.isArray(event.entries) ? event.entries : [];
      const text = entries
        .map((entry) => {
          const item = asRecord(entry);
          const content = asText(item?.content);
          const status = asText(item?.status);
          return content ? (status ? `[${status}] ${content}` : content) : "";
        })
        .filter((line) => line.length > 0)
        .join("\n");
      return text ? [{ kind: "system", ts, text: `plan:\n${text}` }] : [];
    }
    case "devin.permission": {
      const title = asText(event.title);
      const decision = asText(event.decision);
      return [{ kind: "system", ts, text: `permission ${decision}: ${title}` }];
    }
    case "devin.usage":
      // Usage numbers are folded into devin.result; skip the intermediate
      // stream to keep the transcript clean.
      return [];
    case "devin.result": {
      const status = asText(event.status) || "finished";
      const error = asText(event.error);
      const sessionId = asText(event.sessionId);
      const usage = asRecord(event.usage);
      const readToken = (key: string) =>
        typeof usage?.[key] === "number" ? (usage[key] as number) : 0;
      const isError = status !== "finished";
      return [{
        kind: "result",
        ts,
        text: error || `Devin run ${status}${sessionId ? ` (session ${sessionId})` : ""}`,
        inputTokens: readToken("inputTokens"),
        outputTokens: readToken("outputTokens"),
        cachedTokens: readToken("cachedTokens"),
        costUsd: 0,
        subtype: status,
        isError,
        errors: error ? [error] : [],
      }];
    }
    case "devin.stderr":
      return [{ kind: "stderr", ts, text: asText(event.text) }];
    default:
      return [{ kind: "system", ts, text: trimmed }];
  }
}

export interface StdoutParser {
  parseLine(line: string, ts: string): TranscriptEntry[];
  reset(): void;
}

export function createStdoutParser(): StdoutParser {
  function parseLine(line: string, ts: string): TranscriptEntry[] {
    try {
      return parseStdoutLine(line, ts);
    } catch {
      return [{ kind: "stdout", ts, text: line }];
    }
  }
  function reset() {}
  return { parseLine, reset };
}
