import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "../server/test.js";

function fakeDevinCli(dir: string): string {
  const bin = path.join(dir, "devin-fake");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  version) echo "devin 9.9.9-test" ;;',
      '  auth) echo "Logged in"; echo "Name: Test User" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

function nonexistentPath(label: string): string {
  return path.join(os.tmpdir(), `devin-adapter-test-${label}-${process.pid}-${Date.now()}`);
}

const baseCtx = (config: Record<string, unknown>) => ({
  companyId: "company-1",
  adapterType: "devin_local",
  config,
});

describe("testEnvironment", () => {
  it("passes when the skills home is missing because the first run creates it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-adapter-test-"));
    const command = fakeDevinCli(dir);
    // A HOME that does not exist guarantees ~/.agents is absent.
    const missingHome = nonexistentPath("home");

    const result = await testEnvironment(
      baseCtx({ command, env: { HOME: missingHome } }),
    );

    const skillsCheck = result.checks.find((c) => c.code === "devin_skills_home_missing");
    expect(skillsCheck).toBeDefined();
    // Paperclip's lifecycle gate fails verification on any warn-level check
    // for adapters without a hello probe; self-healing conditions must be info.
    expect(skillsCheck?.level).toBe("info");
    expect(result.status).toBe("pass");
  });

  it("passes when a configured cwd does not exist yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-adapter-test-"));
    const command = fakeDevinCli(dir);

    const result = await testEnvironment(
      baseCtx({ command, cwd: nonexistentPath("cwd") }),
    );

    const cwdCheck = result.checks.find((c) => c.code === "devin_cwd_missing");
    expect(cwdCheck).toBeDefined();
    expect(cwdCheck?.level).toBe("info");
    expect(result.status).toBe("pass");
  });

  it("still fails when the devin command is not resolvable", async () => {
    const result = await testEnvironment(
      baseCtx({ command: nonexistentPath("devin") }),
    );

    expect(result.checks.find((c) => c.code === "devin_not_found")?.level).toBe("error");
    expect(result.status).toBe("fail");
  });
});
