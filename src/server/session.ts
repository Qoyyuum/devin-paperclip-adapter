import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId =
    readString(record.sessionId) ??
    readString(record.devinSessionId) ??
    readString(record.id);
  if (!sessionId) return null;
  const cwd = readString(record.cwd);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
  };
}

/**
 * Codec persisting the Devin session id (and cwd) in Paperclip
 * `sessionParams` between heartbeats, so the next turn resumes the same
 * Devin conversation.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    const normalized = normalize(params);
    return normalized ? String(normalized.sessionId) : null;
  },
};
