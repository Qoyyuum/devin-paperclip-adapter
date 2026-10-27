import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseJson,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  runChildProcess,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { syncDevinSkills } from "./skills.js";
import { executeAcp } from "./acp.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = "swe-2-high";
const DEFAULT_PERMISSION_MODE = "smart";
const PERMISSION_MODES = new Set(["auto", "accept-edits", "smart", "dangerous"]);

// ---------------------------------------------------------------------------
// devin.* stdout events — the only stdout this adapter emits is JSON lines so
// the optional ./ui-parser can render a structured transcript.
// ---------------------------------------------------------------------------

type DevinEvent =
  | { type: "devin.init"; sessionId: string; model?: string; resumed: boolean }
  | { type: "devin.status"; status: string; message?: string }
  | { type: "devin.assistant"; text: string }
  | {
      type: "devin.result";
      status: string;
      sessionId?: string | null;
      model?: string;
      resumed?: boolean;
      error?: string;
    };

function eventLine(event: DevinEvent): string {
  return `${JSON.stringify(event)}\n`;
}

async function emitStatus(
  onLog: AdapterExecutionContext["onLog"],
  status: string,
  message?: string,
) {
  await onLog("stdout", eventLine({ type: "devin.status", status, ...(message ? { message } : {}) }));
}

/**
 * The Devin CLI's `-p` mode prints the final response as plain text. Wrap each
 * complete stdout line in a `devin.assistant` event so the whole run log stays
 * structured; stderr is passed through untouched.
 */
function createDevinEventLog(onLog: AdapterExecutionContext["onLog"]) {
  let buffer = "";
  return {
    log: async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream !== "stdout") {
        await onLog(stream, chunk);
        return;
      }
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        await onLog("stdout", eventLine({ type: "devin.assistant", text: line }));
      }
    },
    flush: async () => {
      const remaining = buffer;
      buffer = "";
      if (remaining.trim().length > 0) {
        await onLog("stdout", eventLine({ type: "devin.assistant", text: remaining }));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Devin session discovery — `devin list --format json` lists the sessions
// stored for the current working directory.
// ---------------------------------------------------------------------------

export interface DevinSessionInfo {
  id: string;
  lastActivityAt: number;
}

async function listDevinSessions(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<DevinSessionInfo[]> {
  try {
    const { stdout } = await execFileAsync(command, ["list", "--format", "json"], {
      cwd,
      env,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = parseJson(stdout);
    if (!Array.isArray(parsed)) return [];
    const sessions: DevinSessionInfo[] = [];
    for (const entry of parsed) {
      const record = parseObject(entry);
      const id = asString(record.id, asString(record.short_id, "")).trim();
      if (!id) continue;
      const activity = asNumber(record.last_activity_at, 0);
      sessions.push({ id, lastActivityAt: activity });
    }
    return sessions;
  } catch {
    return [];
  }
}

/** Exported for tests. */
export function pickDevinSessionId(
  before: DevinSessionInfo[],
  after: DevinSessionInfo[],
): string | null {
  if (after.length === 0) return null;
  const beforeActivity = new Map(before.map((s) => [s.id, s.lastActivityAt]));
  const newest = (list: DevinSessionInfo[]) =>
    list.reduce((a, b) => (a.lastActivityAt >= b.lastActivityAt ? a : b));
  const fresh = after.filter((s) => !beforeActivity.has(s.id));
  if (fresh.length > 0) return newest(fresh).id;
  const bumped = after.filter(
    (s) => s.lastActivityAt > (beforeActivity.get(s.id) ?? 0),
  );
  if (bumped.length > 0) return newest(bumped).id;
  return newest(after).id;
}

/** Exported for tests. */
export function isDevinUnknownSessionError(output: string): boolean {
  return /no session found matching|no such session|session not found/i.test(output);
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function normalizePermissionMode(raw: string): string {
  const value = raw.trim().toLowerCase();
  return PERMISSION_MODES.has(value) ? value : DEFAULT_PERMISSION_MODE;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL?.trim() || !env.PAPERCLIP_API_KEY?.trim()) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Authenticate with `Authorization: Bearer $PAPERCLIP_API_KEY` and include `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on mutating requests.",
  ].join("\n");
}

function buildArgs(input: {
  promptFile: string;
  model: string;
  permissionMode: string;
  sandbox: boolean;
  sessionId: string | null;
  extraArgs: string[];
}): string[] {
  const args = [
    "-p",
    "--prompt-file",
    input.promptFile,
    "--respect-workspace-trust",
    "false",
    "--permission-mode",
    input.permissionMode,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.sandbox) args.push("--sandbox");
  if (input.sessionId) args.push("-r", input.sessionId);
  args.push(...input.extraArgs);
  return args;
}

interface AttemptResult {
  proc: RunProcessResult;
  sessionId: string | null;
  resumed: boolean;
}

/**
 * Run one Devin turn for a Paperclip heartbeat.
 *
 * Spawns the Devin CLI (`devin -p`, or `devin acp` for the acp engine) in
 * the configured working directory, streams `devin.*` JSON events to the
 * run log, and resumes the stored Devin session when the cwd matches.
 * If the stored session is gone, retries once with a fresh session and
 * reports `clearSession`.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  if (ctx.executionTarget && ctx.executionTarget.kind !== "local") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "remote_execution_unsupported",
      errorMessage:
        "devin_local only supports local execution on the Paperclip host. Remote/SSH execution targets are not supported by this adapter.",
      provider: "devin",
      biller: "devin",
      billingType: "subscription",
    };
  }

  const command = asString(config.command, "devin").trim() || "devin";
  const engine = asString(config.engine, "cli").trim().toLowerCase() || "cli";
  const model = asString(config.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const permissionMode = normalizePermissionMode(asString(config.permissionMode, DEFAULT_PERMISSION_MODE));
  const acpMode = asString(config.acpMode, "").trim();
  const sandbox = asBoolean(config.sandbox, false);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const envConfig = parseObject(config.env);
  const extraArgs = asStringArray(config.extraArgs);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId = trimNullable(context.taskId) ?? trimNullable(context.issueId);
  const wakeReason = trimNullable(context.wakeReason);
  const wakeCommentId = trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId);
  const approvalId = trimNullable(context.approvalId);
  const approvalStatus = trimNullable(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  await ensureCommandResolvable(command, cwd, runtimeEnv);

  // Resolve session state: resume only when the stored session was created in
  // the same cwd (Devin sessions are per-working-directory).
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "").trim();
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "").trim();
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  if (runtimeSessionId && !canResumeSession) {
    await emitStatus(
      onLog,
      "session-skipped",
      `Devin session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".`,
    );
  }

  // Skills: link desired Paperclip skills into the global ~/.agents/skills dir
  // Devin already scans. Never writes into the agent's cwd.
  try {
    await syncDevinSkills(config, onLog);
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Warning: could not sync Paperclip skills into ~/.agents/skills: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  await hydrateFreshSessionHandoff(ctx, { resumedSession: canResumeSession });
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: canResumeSession,
    includeCommunicationGuidance: false,
  });
  const renderedPrompt =
    (canResumeSession && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData).trim();
  const prompt = joinPromptSections([
    selectInitialCommunicationGuidance(context, { resumedSession: canResumeSession }),
    wakePrompt,
    taskContextNote,
    renderPaperclipEnvNote(env),
    renderApiAccessNote(env),
    renderedPrompt,
  ]);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const finalPrompt = joinPromptSections([prompt, sessionHandoffNote]);

  if (engine === "acp") {
    if (onMeta) {
      const meta: AdapterInvocationMeta = {
        adapterType: "devin_local",
        command,
        cwd,
        commandArgs: ["acp", ...(model ? ["--model", model] : [])],
        commandNotes: [
          canResumeSession
            ? `Resuming Devin session ${runtimeSessionId} via ACP session/load`
            : "Starting a new Devin session via ACP",
          `Session mode: ${acpMode || permissionMode} (ACP engine)`,
        ],
        env: buildInvocationEnvForLogs(env),
        prompt: finalPrompt,
        promptMetrics: {
          promptChars: finalPrompt.length,
          wakePromptChars: wakePrompt.length,
          taskContextChars: taskContextNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
        context: {
          devin: {
            model,
            permissionMode,
            acpMode: acpMode || null,
            engine,
            sessionId: canResumeSession ? runtimeSessionId : null,
            resumedSession: canResumeSession,
          },
        },
      };
      await onMeta(meta);
    }
    return executeAcp({
      command,
      model,
      permissionMode,
      acpMode: acpMode || undefined,
      cwd,
      env: runtimeEnv,
      prompt: finalPrompt,
      resumeSessionId: canResumeSession ? runtimeSessionId : null,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
    });
  }

  // Materialize the prompt into a temp file: Devin accepts --prompt-file, which
  // keeps large rendered wake payloads off the argv list.
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devin-prompt-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  await fs.writeFile(promptFile, finalPrompt, "utf8");

  const sessionsBefore = await listDevinSessions(command, cwd, runtimeEnv);
  const devinLog = createDevinEventLog(onLog);

  if (onMeta) {
    const meta: AdapterInvocationMeta = {
      adapterType: "devin_local",
      command,
      cwd,
      commandArgs: buildArgs({
        promptFile: "<prompt-file>",
        model,
        permissionMode,
        sandbox,
        sessionId: canResumeSession ? runtimeSessionId : null,
        extraArgs,
      }),
      commandNotes: [
        canResumeSession
          ? `Resuming Devin session ${runtimeSessionId}`
          : "Starting a new Devin session",
        `Permission mode: ${permissionMode}${sandbox ? " (sandboxed exec)" : ""}`,
      ],
      env: buildInvocationEnvForLogs(env),
      prompt: finalPrompt,
      promptMetrics: {
        promptChars: finalPrompt.length,
        wakePromptChars: wakePrompt.length,
        taskContextChars: taskContextNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context: {
        devin: {
          model,
          permissionMode,
          sandbox,
          sessionId: canResumeSession ? runtimeSessionId : null,
          resumedSession: canResumeSession,
        },
      },
    };
    await onMeta(meta);
  }

  if (canResumeSession) {
    await onLog("stdout", eventLine({
      type: "devin.init",
      sessionId: runtimeSessionId,
      model,
      resumed: true,
    }));
  }

  const runAttempt = async (sessionId: string | null): Promise<AttemptResult> => {
    const args = buildArgs({
      promptFile,
      model,
      permissionMode,
      sandbox,
      sessionId,
      extraArgs,
    });
    await emitStatus(
      onLog,
      "running",
      sessionId ? `Resuming Devin session ${sessionId}.` : "Starting a new Devin session.",
    );
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog: devinLog.log,
      onSpawn,
    });
    await devinLog.flush();
    const sessionsAfter = await listDevinSessions(command, cwd, runtimeEnv);
    const capturedId = pickDevinSessionId(sessionsBefore, sessionsAfter) ?? sessionId;
    return { proc, sessionId: capturedId, resumed: sessionId !== null };
  };

  try {
    let attempt = await runAttempt(canResumeSession ? runtimeSessionId : null);
    let clearSession = false;

    // Resume failure: the stored session no longer exists. Retry once fresh
    // and tell Paperclip to forget the stale session.
    if (
      canResumeSession &&
      attempt.proc.exitCode !== 0 &&
      !attempt.proc.timedOut &&
      isDevinUnknownSessionError(`${attempt.proc.stdout}\n${attempt.proc.stderr}`)
    ) {
      await emitStatus(
        onLog,
        "session-retry",
        `Devin session ${runtimeSessionId} no longer exists; starting a fresh session.`,
      );
      attempt = await runAttempt(null);
      clearSession = true;
    }

    const attemptSessionId = attempt.sessionId;
    if (attemptSessionId && !canResumeSession) {
      await onLog("stdout", eventLine({
        type: "devin.init",
        sessionId: attemptSessionId,
        model,
        resumed: false,
      }));
    }
    const result = toResult(attempt, model, cwd, { clearSession });
    await onLog("stdout", eventLine({
      type: "devin.result",
      status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "finished" : "error",
      sessionId: attemptSessionId,
      model,
      resumed: attempt.resumed,
      ...(result.errorMessage ? { error: result.errorMessage } : {}),
    }));
    return result;
  } finally {
    await fs.rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function toResult(
  attempt: AttemptResult,
  model: string,
  cwd: string,
  opts: { clearSession: boolean },
): AdapterExecutionResult {
  const { proc, sessionId, resumed } = attempt;
  const isError = proc.exitCode !== 0 || proc.timedOut;
  const responseText = proc.stdout;
  const errorMessage = proc.timedOut
    ? "Devin run timed out."
    : isError
      ? trimNullable(proc.stderr) ?? trimNullable(responseText) ?? "Devin run failed."
      : null;
  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage,
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: sessionId ? { sessionId, cwd } : null,
    provider: "devin",
    biller: "devin",
    model,
    billingType: "subscription",
    costUsd: null,
    summary: isError ? null : firstNonEmptyLine(responseText),
    clearSession: opts.clearSession,
    resultJson: {
      status: proc.timedOut ? "timed_out" : isError ? "error" : "finished",
      devinSessionId: sessionId,
      resumed,
      model,
      ...(proc.timedOut ? { timedOut: true } : {}),
      ...(trimNullable(proc.stderr) ? { stderr: trimNullable(proc.stderr) } : {}),
    },
  };
}
