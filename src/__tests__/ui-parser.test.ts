import { describe, expect, it } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../ui-parser.js";

const TS = "2026-10-25T00:00:00.000Z";

describe("parseStdoutLine", () => {
  it("maps devin.init to an init entry", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "devin.init", sessionId: "grass-satellite", model: "swe-2-high", resumed: true }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "init", ts: TS, model: "swe-2-high", sessionId: "grass-satellite" },
    ]);
  });

  it("maps devin.status to a system entry", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "devin.status", status: "running", message: "Starting a new Devin session." }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "system", ts: TS, text: "[running] Starting a new Devin session." },
    ]);
  });

  it("maps devin.assistant to an assistant entry", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "devin.assistant", text: "Done." }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "Done.", delta: true }]);
  });

  it("maps devin.result errors to a result entry", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "devin.result", status: "error", error: "boom", sessionId: "s1" }),
      TS,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("result");
    expect(entries[0]).toMatchObject({ isError: true, subtype: "error", errors: ["boom"] });
  });

  it("maps a finished devin.result to a non-error result", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "devin.result", status: "finished", sessionId: "s1" }),
      TS,
    );
    expect(entries[0]).toMatchObject({ kind: "result", isError: false, subtype: "finished" });
  });

  it("falls back to stdout for non-JSON and non-devin lines", () => {
    expect(parseStdoutLine("plain text", TS)).toEqual([{ kind: "stdout", ts: TS, text: "plain text" }]);
    expect(parseStdoutLine('{"type":"other.x","a":1}', TS)).toEqual([
      { kind: "stdout", ts: TS, text: '{"type":"other.x","a":1}' },
    ]);
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("never throws on malformed input", () => {
    const parser = createStdoutParser();
    expect(() => parser.parseLine("{not json", TS)).not.toThrow();
    expect(() => parser.parseLine("null", TS)).not.toThrow();
    expect(parser.parseLine("{not json", TS)).toEqual([{ kind: "stdout", ts: TS, text: "{not json" }]);
  });
});
