import { describe, expect, it } from "vitest";
import { sessionCodec } from "../server/session.js";

describe("sessionCodec", () => {
  it("round-trips a session with cwd", () => {
    const params = { sessionId: "grass-satellite", cwd: "/tmp/work" };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual({ sessionId: "grass-satellite", cwd: "/tmp/work" });
    expect(sessionCodec.deserialize(serialized)).toEqual(params);
  });

  it("normalizes missing cwd", () => {
    expect(sessionCodec.deserialize({ sessionId: "abc" })).toEqual({ sessionId: "abc" });
  });

  it("accepts legacy/alternate id fields", () => {
    expect(sessionCodec.deserialize({ devinSessionId: "s1" })).toEqual({ sessionId: "s1" });
    expect(sessionCodec.deserialize({ id: "s2" })).toEqual({ sessionId: "s2" });
  });

  it("returns null for unusable payloads", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("session-id")).toBeNull();
    expect(sessionCodec.deserialize([])).toBeNull();
    expect(sessionCodec.deserialize({})).toBeNull();
  });

  it("getDisplayId returns the session id", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "grass-satellite" })).toBe("grass-satellite");
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
