import { describe, expect, it } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  CONVERSATION_CONTINUATION_POLICY,
  conversationContinuationFields,
} from "../server/recovery.js";
import { toResult } from "../server/execute.js";

const proc = (overrides: Partial<RunProcessResult>): RunProcessResult =>
  ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "done\n",
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
    ...overrides,
  }) as RunProcessResult;

describe("conversationContinuationFields", () => {
  it("uses the policy id Paperclip recognizes", () => {
    expect(CONVERSATION_CONTINUATION_POLICY).toBe("continue_conversation_v1");
  });

  it("marks failed and timed-out turns as continuable", () => {
    expect(conversationContinuationFields("error")).toEqual({
      conversationContinuation: "continue_conversation_v1",
    });
    expect(conversationContinuationFields("timed_out")).toEqual({
      conversationContinuation: "continue_conversation_v1",
    });
  });

  it("leaves finished and cancelled turns unmarked", () => {
    expect(conversationContinuationFields("finished")).toEqual({});
    expect(conversationContinuationFields("cancelled")).toEqual({});
  });
});

describe("cli toResult", () => {
  const attempt = (p: RunProcessResult) => ({ proc: p, sessionId: "sess-1", resumed: true });

  it("stamps the continuation policy on a nonzero exit", () => {
    const result = toResult(attempt(proc({ exitCode: 1, stderr: "boom" })), "swe-2-high", "/w", {
      clearSession: false,
    });
    expect(result.resultJson).toMatchObject({
      status: "error",
      conversationContinuation: "continue_conversation_v1",
    });
  });

  it("stamps the continuation policy on a timeout", () => {
    const result = toResult(attempt(proc({ exitCode: null, timedOut: true })), "swe-2-high", "/w", {
      clearSession: false,
    });
    expect(result.resultJson).toMatchObject({
      status: "timed_out",
      conversationContinuation: "continue_conversation_v1",
    });
  });

  it("does not stamp a successful turn", () => {
    const result = toResult(attempt(proc({})), "swe-2-high", "/w", { clearSession: false });
    expect(result.resultJson?.status).toBe("finished");
    expect(result.resultJson).not.toHaveProperty("conversationContinuation");
  });
});
