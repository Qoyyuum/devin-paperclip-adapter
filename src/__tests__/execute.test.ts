import { describe, expect, it } from "vitest";
import {
  isDevinUnknownSessionError,
  pickDevinSessionId,
  type DevinSessionInfo,
} from "../server/execute.js";

const s = (id: string, t: number): DevinSessionInfo => ({ id, lastActivityAt: t });

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
