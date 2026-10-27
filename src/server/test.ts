import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveDevinSkillsHome, DEVIN_SKILLS_HOME_LABEL } from "./skills.js";
import { probeDevinAcp } from "./acp.js";

const execFileAsync = promisify(execFile);

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

async function probe(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const output =
      err instanceof Error && "stdout" in err
        ? `${(err as { stdout?: string }).stdout ?? ""}\n${(err as { stderr?: string }).stderr ?? ""}`.trim()
        : "";
    return {
      ok: false,
      output: output || (err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Run the adapter's pre-flight environment checks: local-only execution
 * target, absolute cwd, `devin` CLI resolvable in PATH, completed
 * `devin auth login`, ACP handshake (acp engine only), and skills-home
 * reachability. Any `error`-level check blocks hiring on this adapter.
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "devin").trim() || "devin";
  const cwd = asString(config.cwd, "").trim();
  const model = asString(config.model, "").trim();
  const engine = asString(config.engine, "cli").trim().toLowerCase() || "cli";

  let cwdStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  if (ctx.executionTarget && ctx.executionTarget.kind !== "local") {
    checks.push({
      code: "devin_remote_unsupported",
      level: "error",
      message: "devin_local only supports local execution on the Paperclip host.",
      detail: `Execution target kind: ${ctx.executionTarget.kind}`,
    });
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  if (cwd) {
    if (!path.isAbsolute(cwd)) {
      checks.push({
        code: "devin_cwd_not_absolute",
        level: "error",
        message: "cwd must be an absolute path.",
        detail: cwd,
      });
    } else {
      cwdStat = await fs.stat(cwd).catch(() => null);
      checks.push(
        cwdStat?.isDirectory()
          ? { code: "devin_cwd_ok", level: "info", message: `Working directory exists: ${cwd}` }
          : {
              code: "devin_cwd_missing",
              // Info, not warn: Paperclip's lifecycle gate fails verification on
              // any warn check for adapters without a hello probe, and the first
              // run creates this directory — a warn would wedge the agent in
              // `verifying` forever.
              level: "info",
              message: `Working directory does not exist yet: ${cwd}`,
              hint: "It will be created on the first run.",
            },
      );
    }
  }

  // Probe in the configured cwd only when it already exists; the first run
  // creates a missing cwd, so spawning probes in it would fail with ENOENT and
  // surface as a misleading devin_not_found error.
  const probeCwd = cwdStat?.isDirectory() ? cwd : process.cwd();
  const version = await probe(command, ["version"], probeCwd);
  if (version.ok) {
    checks.push({
      code: "devin_version_ok",
      level: "info",
      message: `Devin CLI found: ${version.output.split(/\r?\n/)[0]}`,
    });
  } else {
    checks.push({
      code: "devin_not_found",
      level: "error",
      message: `"${command}" is not resolvable in PATH.`,
      detail: version.output,
      hint: "Install the Devin CLI on the Paperclip host or set the command field to an absolute path.",
    });
  }

  if (version.ok) {
    const auth = await probe(command, ["auth", "status"], probeCwd);
    if (auth.ok && /logged in/i.test(auth.output)) {
      const userLine = auth.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("Name:"));
      checks.push({
        code: "devin_auth_ok",
        level: "info",
        message: "Devin CLI is authenticated.",
        ...(userLine ? { detail: userLine } : {}),
      });
    } else {
      checks.push({
        code: "devin_auth_missing",
        level: "error",
        message: "Devin CLI is not logged in.",
        detail: auth.output || undefined,
        hint: "Run `devin auth login` on the Paperclip host as the OS user that runs Paperclip.",
      });
    }
  }

  if (model) {
    checks.push({
      code: "devin_model_configured",
      level: "info",
      message: `Model configured: ${model}`,
      hint: "The run will fail if this model id is not available to the Devin account; see `devin models list`.",
    });
  }

  if (engine === "acp") {
    // The ACP hello probe performs a real initialize handshake against
    // `devin acp`. Passing it emits the hello_probe check Paperclip's
    // lifecycle gate requires to mark the adapter verified.
    const hello = await probeDevinAcp(command, probeCwd, process.env as Record<string, string>);
    if (hello.ok && !hello.authRequired) {
      checks.push({
        code: "devin_hello_probe_passed",
        level: "info",
        message: "Devin ACP initialize handshake succeeded.",
        detail: hello.detail,
      });
    } else if (hello.ok && hello.authRequired) {
      checks.push({
        code: "devin_hello_probe_auth_required",
        level: "error",
        message: "Devin ACP requires authentication.",
        detail: hello.detail,
        hint: "Run `devin auth login` on the Paperclip host as the OS user that runs Paperclip.",
      });
    } else {
      checks.push({
        code: "devin_hello_probe_failed",
        level: "error",
        message: "Devin ACP initialize handshake failed.",
        detail: hello.detail,
        hint: "Check `devin acp` works on the Paperclip host (devin doctor).",
      });
    }
  }

  const skillsHome = resolveDevinSkillsHome(config);
  const skillsParent = await fs.stat(path.dirname(skillsHome)).catch(() => null);
  checks.push(
    skillsParent?.isDirectory()
      ? {
          code: "devin_skills_home_ok",
          level: "info",
          message: `Devin skills directory reachable: ${skillsHome}`,
        }
      : {
          code: "devin_skills_home_missing",
          // Info, not warn: same lifecycle-gate reason as devin_cwd_missing —
          // syncDevinSkills creates this directory on the first run, so the
          // warning can never clear itself before verification.
          level: "info",
          message: `Devin skills directory ${DEVIN_SKILLS_HOME_LABEL} does not exist under ${path.dirname(skillsHome)}.`,
          hint: "It will be created on the first run when skills are synced.",
        },
  );

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
