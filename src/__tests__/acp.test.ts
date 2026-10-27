import { describe, expect, it } from "vitest";
import {
  acpUpdateToDevinEvents,
  devinAcpModeForPermissionMode,
  selectPermissionOption,
} from "../server/acp.js";

describe("devinAcpModeForPermissionMode", () => {
  it("maps adapter modes onto devin ACP modes", () => {
    expect(devinAcpModeForPermissionMode("dangerous")).toBe("bypass");
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
