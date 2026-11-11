import { describe, expect, it } from "vitest";
import {
  isDevinUnknownSessionError,
  pickDevinSessionId,
  resolvePermissionMode,
  type DevinSessionInfo,
} from "../server/execute.js";

const s = (id: string, t: number): DevinSessionInfo => ({ id, lastActivityAt: t });

describe("resolvePermissionMode", () => {
  it("defaults to dangerous so headless runs can act", () => {
    expect(resolvePermissionMode({})).toEqual({ permissionMode: "dangerous", sandbox: false });
  });

  it("defaults to autonomous when sandbox is enabled", () => {
    expect(resolvePermissionMode({ sandbox: true })).toEqual({ permissionMode: "autonomous", sandbox: true });
  });

  it("keeps an explicit valid mode", () => {
    expect(resolvePermissionMode({ permissionMode: "smart" })).toEqual({ permissionMode: "smart", sandbox: false });
    expect(resolvePermissionMode({ permissionMode: "Dangerous" })).toEqual({ permissionMode: "dangerous", sandbox: false });
  });

  it("lets autonomous imply the sandbox flag the CLI requires", () => {
    expect(resolvePermissionMode({ permissionMode: "autonomous" })).toEqual({ permissionMode: "autonomous", sandbox: true });
  });

  it("lets sandbox override an explicit mode, as the Devin CLI does", () => {
    expect(resolvePermissionMode({ sandbox: true, permissionMode: "smart" })).toEqual({
      permissionMode: "autonomous",
      sandbox: true,
    });
  });

  it("fails closed to smart for unknown values", () => {
    expect(resolvePermissionMode({ permissionMode: "bogus" })).toEqual({ permissionMode: "smart", sandbox: false });
    expect(resolvePermissionMode({ sandbox: true, permissionMode: "bogus" })).toEqual({
      permissionMode: "autonomous",
      sandbox: true,
    });
  });

  it("ignores sandbox for the acp engine, which cannot sandbox exec", () => {
    expect(resolvePermissionMode({ sandbox: true }, "acp")).toEqual({
      permissionMode: "dangerous",
      sandbox: false,
    });
    expect(resolvePermissionMode({ permissionMode: "autonomous" }, "acp")).toEqual({
      permissionMode: "autonomous",
      sandbox: false,
    });
  });
});

describe("pickDevinSessionId", () => {
  it("prefers a session that appeared during the run", () => {
    const before = [s("old-one", 100)];
    const after = [s("old-one", 100), s("new-one", 200)];
    expect(pickDevinSessionId(before, after)).toBe("new-one");
  });

  it("picks the freshest new session when several appear", () => {
    const after = [s("a", 10), s("b", 30), s("c", 20)];
    expect(pickDevinSessionId([], after)).toBe("b");
  });

  it("falls back to a session whose activity bumped", () => {
    const before = [s("keep", 100), s("other", 100)];
    const after = [s("keep", 250), s("other", 100)];
    expect(pickDevinSessionId(before, after)).toBe("keep");
  });

  it("falls back to the most recent session overall", () => {
    const before = [s("x", 100), s("y", 50)];
    const after = [s("x", 100), s("y", 50)];
    expect(pickDevinSessionId(before, after)).toBe("x");
  });

  it("returns null when no sessions exist", () => {
    expect(pickDevinSessionId([], [])).toBeNull();
  });
});

describe("isDevinUnknownSessionError", () => {
  it("matches the devin resume error", () => {
    expect(isDevinUnknownSessionError("Error: No session found matching 'gone'")).toBe(true);
    expect(isDevinUnknownSessionError("session not found")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isDevinUnknownSessionError("command not found")).toBe(false);
    expect(isDevinUnknownSessionError("")).toBe(false);
  });
});
