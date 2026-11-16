import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  acpUpdateToDevinEvents,
  devinAcpModeForPermissionMode,
  executeAcp,
  isRetryableProviderError,
  providerErrorKind,
  selectPermissionOption,
} from "../server/acp.js";

describe("devinAcpModeForPermissionMode", () => {
  it("maps adapter modes onto devin ACP modes", () => {
    expect(devinAcpModeForPermissionMode("dangerous")).toBe("bypass");
    expect(devinAcpModeForPermissionMode("autonomous")).toBe("bypass");
    expect(devinAcpModeForPermissionMode("accept-edits")).toBe("accept-edits");
    expect(devinAcpModeForPermissionMode("smart")).toBe("smart");
    expect(devinAcpModeForPermissionMode("auto")).toBe("smart");
    expect(devinAcpModeForPermissionMode("anything-else")).toBe("smart");
  });
});

describe("selectPermissionOption", () => {
  const options = [
    { optionId: "allow-1", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-1", kind: "reject_once" },
  ] as const;

  it("approves under dangerous", () => {
    expect(selectPermissionOption(options, "dangerous")).toBe("allow-1");
  });

  it("approves under autonomous", () => {
    expect(selectPermissionOption(options, "autonomous")).toBe("allow-1");
  });

  it("rejects under every other mode", () => {
    expect(selectPermissionOption(options, "smart")).toBe("reject-1");
    expect(selectPermissionOption(options, "auto")).toBe("reject-1");
    expect(selectPermissionOption(options, "accept-edits")).toBe("reject-1");
  });

  it("returns null when no matching option exists", () => {
    expect(selectPermissionOption([{ optionId: "x", kind: "allow_always" }], "smart")).toBeNull();
  });
});

describe("acpUpdateToDevinEvents", () => {
  it("maps message and thought chunks", () => {
    expect(
      acpUpdateToDevinEvents({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      } as never),
    ).toEqual([{ type: "devin.assistant", text: "hello" }]);
    expect(
      acpUpdateToDevinEvents({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hmm" },
      } as never),
    ).toEqual([{ type: "devin.thinking", text: "hmm" }]);
  });

  it("maps tool calls and results", () => {
    expect(
      acpUpdateToDevinEvents({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Reading file",
        name: "read",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "/tmp/x" },
      } as never),
    ).toEqual([
      {
        type: "devin.tool_call",
        toolCallId: "tc1",
        name: "read",
        title: "Reading file",
        kind: "read",
        status: "in_progress",
        input: { path: "/tmp/x" },
      },
    ]);
    expect(
      acpUpdateToDevinEvents({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "boom" } }],
      } as never),
    ).toEqual([
      {
        type: "devin.tool_result",
        toolCallId: "tc1",
        status: "failed",
        content: "boom",
        isError: true,
      },
    ]);
  });

  it("maps usage updates including cognition token meta", () => {
    expect(
      acpUpdateToDevinEvents({
        sessionUpdate: "usage_update",
        used: 100,
        size: 262000,
        _meta: {
          "cognition.ai/inputTokens": 90,
          "cognition.ai/outputTokens": 10,
          "cognition.ai/cachedReadTokens": 5,
        },
      } as never),
    ).toEqual([
      {
        type: "devin.usage",
        used: 100,
        size: 262000,
        inputTokens: 90,
        outputTokens: 10,
        cachedTokens: 5,
      },
    ]);
  });

  it("ignores uninteresting update kinds", () => {
    expect(
      acpUpdateToDevinEvents({ sessionUpdate: "available_commands_update", availableCommands: [] } as never),
    ).toEqual([]);
  });
});

describe("isRetryableProviderError", () => {
  it("detects the Devin unavailable/retryable provider error", () => {
    const err = new RequestError(-32010, "Connection error, send a message to continue retrying", {
      "cognition.ai/errorKind": "unavailable",
      "cognition.ai/retryable": true,
    });
    expect(isRetryableProviderError(err)).toBe(true);
    expect(providerErrorKind(err)).toBe("unavailable");
  });

  it("detects errorKind=unavailable even without the retryable flag", () => {
    const err = new RequestError(-32010, "unavailable", { "cognition.ai/errorKind": "unavailable" });
    expect(isRetryableProviderError(err)).toBe(true);
    expect(providerErrorKind(err)).toBe("unavailable");
  });

  it("detects retryable=true even without an errorKind", () => {
    const err = new RequestError(-32010, "retry me", { "cognition.ai/retryable": true });
    expect(isRetryableProviderError(err)).toBe(true);
    expect(providerErrorKind(err)).toBeNull();
  });

  it("rejects non-retryable errors", () => {
    expect(isRetryableProviderError(new RequestError(-32603, "boom"))).toBe(false);
    expect(
      isRetryableProviderError(
        new RequestError(-32010, "nope", { "cognition.ai/retryable": false }),
      ),
    ).toBe(false);
    expect(isRetryableProviderError(new Error("ACP connection closed"))).toBe(false);
    expect(isRetryableProviderError("unavailable")).toBe(false);
    expect(providerErrorKind(new Error("x"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executeAcp provider-retry integration tests. A fake `devin` shim execs a
// node script that speaks newline-delimited JSON-RPC just like `devin acp`,
// with the failure mode driven by FAKE_ACP_MODE and request counts persisted
// to FAKE_ACP_STATE_FILE so they survive a process respawn. The shim is a
// POSIX shell script, so these are POSIX-only like the other fake-devin tests.
// ---------------------------------------------------------------------------

const FAKE_ACP_SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const MODE = process.env.FAKE_ACP_MODE || "succeed";
const STATE = process.env.FAKE_ACP_STATE_FILE;
const bump = (key) => {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  state[key] = (state[key] || 0) + 1;
  fs.writeFileSync(STATE, JSON.stringify(state));
  return state[key];
};
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const retryableError = (id) => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: -32010,
    message: "Connection error, send a message to continue retrying",
    data: { "cognition.ai/errorKind": "unavailable", "cognition.ai/retryable": true },
  },
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.id === null) return; // notification
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session-1" } });
  } else if (method === "session/load") {
    bump("loads");
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "session/set_mode") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "session/prompt") {
    const n = bump("prompts");
    // die-then-succeed: report the retryable error on the first prompt, then
    // die on the continuation prompt without responding — the real-world
    // sequence of a provider error followed by the connection dropping.
    if (MODE === "die-then-succeed" && n === 2) process.exit(1);
    if (MODE === "always-fail") {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "boom" } });
    } else if (MODE === "always-retryable" || ((MODE === "retry-then-succeed" || MODE === "die-then-succeed") && n === 1)) {
      send(retryableError(id));
    } else {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all done" } } } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
`;

function fakeAcpDevin(dir: string): { command: string; stateFile: string } {
  const server = path.join(dir, "fake-acp-server.cjs");
  fs.writeFileSync(server, FAKE_ACP_SERVER);
  const bin = path.join(dir, "devin-fake");
  fs.writeFileSync(
    bin,
    ["#!/bin/sh", `exec "${process.execPath}" "${server}" "$@"`, ""].join("\n"),
    { mode: 0o755 },
  );
  return { command: bin, stateFile: path.join(dir, "state.json") };
}

function readState(stateFile: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function runFakeAcp(dir: string, mode: string) {
  const { command, stateFile } = fakeAcpDevin(dir);
  const stdout: string[] = [];
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  env.FAKE_ACP_MODE = mode;
  env.FAKE_ACP_STATE_FILE = stateFile;
  const result = executeAcp({
    command,
    model: "swe-2-high",
    permissionMode: "dangerous",
    cwd: dir,
    env,
    prompt: "do the thing",
    resumeSessionId: null,
    timeoutSec: 0,
    graceSec: 20,
    retryBackoffMs: [10, 10, 10],
    onLog: async (_stream, chunk) => {
      stdout.push(chunk);
    },
  });
  return { result, stdout, stateFile };
}

describe.skipIf(process.platform === "win32")("executeAcp provider retries", () => {
  it("continues the same session after a retryable provider error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-acp-retry-"));
    const { result, stdout, stateFile } = runFakeAcp(dir, "retry-then-succeed");
    const res = await result;

    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("fake-session-1");
    expect(readState(stateFile).prompts).toBe(2);
    const retryEvents = stdout.filter((l) => l.includes('"provider-retry"'));
    expect(retryEvents.length).toBe(1);
    expect(res.resultJson?.providerRetryAttempts).toBe(1);
    expect(res.resultJson?.retryableProviderError).toBeUndefined();
  });

  it("respawns devin acp and resumes the session when the child died", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-acp-respawn-"));
    const { result, stdout, stateFile } = runFakeAcp(dir, "die-then-succeed");
    const res = await result;

    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("fake-session-1");
    const state = readState(stateFile);
    // prompt 1: retryable error on the live child; prompt 2: continuation hits
    // the dead child; prompt 3: continuation on the respawned agent.
    expect(state.prompts).toBe(3);
    expect(state.loads).toBe(1);
    const log = stdout.join("");
    expect(log).toContain('"provider-retry"');
    expect(log).toContain("restarted; resumed Devin session fake-session-1");
  });

  it("does not retry non-retryable prompt errors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-acp-fail-"));
    const { result, stateFile } = runFakeAcp(dir, "always-fail");
    const res = await result;

    expect(res.exitCode).toBe(1);
    expect(res.errorMessage).toBe("boom");
    expect(readState(stateFile).prompts).toBe(1);
    expect(res.resultJson?.retryableProviderError).toBeUndefined();
    expect(res.resultJson?.providerRetryAttempts).toBeUndefined();
  });

  it("caps retries and flags the failure as a retryable provider error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-acp-cap-"));
    const { result, stateFile } = runFakeAcp(dir, "always-retryable");
    const res = await result;

    expect(res.exitCode).toBe(1);
    expect(res.errorMessage).toContain("Connection error");
    expect(readState(stateFile).prompts).toBe(4); // initial + 3 retries
    expect(res.resultJson?.providerRetryAttempts).toBe(3);
    expect(res.resultJson?.retryableProviderError).toBe(true);
    expect(res.resultJson?.providerErrorKind).toBe("unavailable");
  });
});
