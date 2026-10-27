import { describe, expect, it } from "vitest";
import { parseDevinModelsList } from "../server/models.js";

const SAMPLE = `Available models (44 families)

Adaptive (adaptive)
  adaptive                                                                  Adaptive  [$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]

SWE-2 (swe-2)
  aliases: swe
  swe-2-high                                                                SWE-2 High  [262K context, Free]
  swe-2-medium                                                              SWE-2 Medium  [262K context, Free]
  swe-2-max                                                                 SWE-2 Max  [262K context, Free]
  swe-2-medium-lightning                                                    SWE-2 Medium Lightning  [262144 context, $1 / 1M Input]

Claude Fable 5.1 (claude-fable-5.1)
  aliases: fable
  claude-fable-5-1-medium                                                   Claude Fable 5.1 Medium  [1M context, $10 / 1M Input]
`;

describe("parseDevinModelsList", () => {
  it("extracts model ids and labels", () => {
    const models = parseDevinModelsList(SAMPLE);
    const ids = models.map((m) => m.id);
    expect(ids).toEqual([
      "adaptive",
      "swe-2-high",
      "swe-2-medium",
      "swe-2-max",
      "swe-2-medium-lightning",
      "claude-fable-5-1-medium",
    ]);
    expect(models.find((m) => m.id === "swe-2-high")?.label).toBe("SWE-2 High");
  });

  it("skips family headers and alias lines", () => {
    const ids = parseDevinModelsList(SAMPLE).map((m) => m.id);
    expect(ids).not.toContain("aliases");
    expect(ids).not.toContain("swe-2)");
    expect(ids).not.toContain("swe");
  });

  it("returns an empty list for garbage input", () => {
    expect(parseDevinModelsList("")).toEqual([]);
    expect(parseDevinModelsList("error: not logged in")).toEqual([]);
  });
});
