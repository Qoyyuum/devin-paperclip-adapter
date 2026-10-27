import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  PermissionOption,
  PromptResponse,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";

// ---------------------------------------------------------------------------
// devin.* stdout events emitted by the ACP path. The ui-parser renders these
// the same way it renders the CLI path's events; the ACP path additionally
// emits thinking, tool_call, tool_result, plan, permission, and usage events.
// ---------------------------------------------------------------------------

export type DevinAcpEvent =
  | { type: "devin.init"; sessionId: string; model?: string; resumed: boolean; engine: "acp" }
  | { type: "devin.status"; status: string; message?: string }
  | { type: "devin.assistant"; text: string }
  | { type: "devin.thinking"; text: string }
  | {
      type: "devin.tool_call";
      toolCallId: string;
      name: string | null;
      title: string;
      kind: string | null;
      status: string | null;
      input: unknown;
    }
  | {
      type: "devin.tool_result";
      toolCallId: string;
      status: string | null;
      content: string;
      isError: boolean;
    }
  | { type: "devin.plan"; entries: Array<{ content?: string; status?: string }> }
  | { type: "devin.permission"; title: string; decision: string }
  | {
      type: "devin.usage";
      used: number;
      size: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
    }
  | {
      type: "devin.result";
      status: string;
      sessionId?: string | null;
      model?: string;
      resumed?: boolean;
      error?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
    };

function line(event: DevinAcpEvent): string {
  return `${JSON.stringify(event)}\n`;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

/**
 * Maps the adapter's permissionMode onto a Devin ACP session mode id. Devin's
 * ACP modes are ask, plan, smart, accept-edits, and bypass; the adapter's
 * "dangerous" means approve everything, which is "bypass" on the wire.
 */
export function devinAcpModeForPermissionMode(permissionMode: string): string {
  switch (permissionMode) {
    case "dangerous":
      return "bypass";
    case "accept-edits":
      return "accept-edits";
    case "auto":
    case "smart":
    default:
      return "smart";
  }
}

/**
 * Picks a permission option for a headless run. Under "dangerous" every
 * request is approved. Under every other mode the Devin session mode already
 * gates tool calls, so a request that still reaches the client is an
 * escalation the agent itself would not auto-approve — reject it.
 */
export function selectPermissionOption(
  options: ReadonlyArray<Pick<PermissionOption, "optionId" | "kind">>,
  permissionMode: string,
): string | null {
  const want = permissionMode === "dangerous" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of want) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  return null;
}

function textOfContentBlock(block: ContentBlock | undefined | null): string {
  if (!block) return "";
  if (block.type === "text") return block.text;
  return "";
}

function textOfToolCallContent(contents: ReadonlyArray<ToolCallContent> | undefined | null): string {
  if (!contents) return "";
  const parts: string[] = [];
  for (const content of contents) {
    if (content.type === "content") {
      const text = textOfContentBlock(content.content);
      if (text) parts.push(text);
    } else if (content.type === "diff") {
      parts.push(`diff: ${content.path}`);
    } else if (content.type === "terminal") {
      parts.push(`terminal: ${content.terminalId}`);
    }
  }
  return parts.join("\n");
}

/** Translates one session/update payload into devin.* events for the run log. */
export function acpUpdateToDevinEvents(update: SessionUpdate): DevinAcpEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOfContentBlock(update.content);
      return text ? [{ type: "devin.assistant", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = textOfContentBlock(update.content);
      return text ? [{ type: "devin.thinking", text }] : [];
    }
    case "tool_call":
      return [
        {
          type: "devin.tool_call",
          toolCallId: update.toolCallId,
          name: update.name ?? null,
          title: update.title,
          kind: update.kind ?? null,
          status: update.status ?? null,
          input: update.rawInput ?? null,
        },
      ];
    case "tool_call_update":
      return [
        {
          type: "devin.tool_result",
          toolCallId: update.toolCallId,
          status: update.status ?? null,
          content: textOfToolCallContent(update.content),
          isError: update.status === "failed",
        },
      ];
    case "plan":
    case "plan_update": {
      const entries = "entries" in update && Array.isArray(update.entries) ? update.entries : [];
      return [{ type: "devin.plan", entries }];
    }
    case "usage_update": {
      const meta = (update._meta ?? {}) as Record<string, unknown>;
      const usage = meta["cognition.ai/inputTokens"] !== undefined || meta["cognition.ai/outputTokens"] !== undefined
        ? meta
        : {};
      return [
        {
          type: "devin.usage",
          used: update.used,
          size: update.size,
          inputTokens: typeof usage["cognition.ai/inputTokens"] === "number" ? usage["cognition.ai/inputTokens"] : undefined,
          outputTokens: typeof usage["cognition.ai/outputTokens"] === "number" ? usage["cognition.ai/outputTokens"] : undefined,
          cachedTokens: typeof usage["cognition.ai/cachedReadTokens"] === "number" ? usage["cognition.ai/cachedReadTokens"] : undefined,
        },
      ];
    }
    case "current_mode_update":
      return [
        {
          type: "devin.status",
          status: "mode",
          message: `Devin session mode: ${update.currentModeId}`,
        },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------

export interface AcpExecuteOptions {
  command: string;
  model: string;
  permissionMode: string;
  /** Optional verbatim Devin ACP mode id overriding the permissionMode map. */
  acpMode?: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  resumeSessionId: string | null;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}

interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  used?: number;
  size?: number;
}

const DEVIN_DIAGNOSTICS_METHOD = "_cognition.ai/request_diagnostics";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeAcp(options: AcpExecuteOptions): Promise<AdapterExecutionResult> {
  const { command, model, permissionMode, cwd, env, prompt, resumeSessionId, timeoutSec, graceSec, onLog, onSpawn } = options;
  const modeId = options.acpMode?.trim() || devinAcpModeForPermissionMode(permissionMode);

  const args = ["acp", ...(model ? ["--model", model] : [])];
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const startedAt = new Date().toISOString();
  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    void onLog("stderr", text);
  });
  if (typeof child.pid === "number" && onSpawn) {
    await onSpawn({ pid: child.pid, processGroupId: null, startedAt });
  }

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  const usage: UsageTotals = {};
  let assistantText = "";
  const emit = async (event: DevinAcpEvent) => onLog("stdout", line(event));

  const resolveInCwd = (rawPath: string): string => {
    const resolved = path.resolve(cwd, rawPath);
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
      throw RequestError.invalidParams({ path: rawPath }, "path is outside the session cwd");
    }
    return resolved;
  };

  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        for (const event of acpUpdateToDevinEvents(params.update)) {
          if (event.type === "devin.assistant") assistantText += event.text;
          if (event.type === "devin.usage") {
            usage.used = event.used;
            usage.size = event.size;
            if (event.inputTokens !== undefined) usage.inputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) usage.outputTokens = event.outputTokens;
            if (event.cachedTokens !== undefined) usage.cachedTokens = event.cachedTokens;
          }
          await emit(event);
        }
      },
      requestPermission: async (params) => {
        const optionId = selectPermissionOption(params.options, permissionMode);
        const title = params.toolCall.title ?? params.toolCall.toolCallId;
        await emit({
          type: "devin.permission",
          title,
          decision: optionId ? (permissionMode === "dangerous" ? "approved" : "rejected") : "cancelled",
        });
        return optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      readTextFile: async (params) => {
        const target = resolveInCwd(params.path);
        let content = await fs.readFile(target, "utf8");
        if (params.line != null || params.limit != null) {
          const lines = content.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          content = lines.slice(start, params.limit != null ? start + params.limit : undefined).join("\n");
        }
        return { content };
      },
      writeTextFile: async (params) => {
        const target = resolveInCwd(params.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, params.content, "utf8");
        return {};
      },
      extMethod: async (method) => {
        // Devin issues a diagnostics round-trip at the end of each turn;
        // answering with an empty object satisfies it.
        if (method === DEVIN_DIAGNOSTICS_METHOD) return {};
        throw RequestError.methodNotFound(method);
      },
      extNotification: async () => {},
    }),
    stream,
  );

  let sessionId: string | null = null;
  let resumed = false;
  let clearSession = false;
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let promptResponse: PromptResponse | null = null;
  let failure: string | null = null;

  try {
    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: {
        name: "paperclip-devin-adapter",
        title: "Paperclip Devin Adapter",
        version: "0.1.0",
      },
    });

    // init.authMethods lists the methods the agent *supports* — not ones it
    // requires. A logged-in devin still advertises devin-browser, so this is
    // not treated as an auth failure; an actual refusal surfaces as a
    // RequestError below.
    if (resumeSessionId && init.agentCapabilities?.loadSession) {
      try {
        await connection.loadSession({ sessionId: resumeSessionId, cwd, mcpServers: [] });
        sessionId = resumeSessionId;
        resumed = true;
      } catch (err) {
        await emit({
          type: "devin.status",
          status: "session-retry",
          message: `Devin session ${resumeSessionId} could not be loaded; starting a fresh session.`,
        });
        void err;
      }
    }
    if (!sessionId) {
      const created = await connection.newSession({ cwd, mcpServers: [] });
      sessionId = created.sessionId;
      clearSession = resumeSessionId !== null;
    }

    await emit({ type: "devin.init", sessionId, model, resumed, engine: "acp" });

    // Const capture: sessionId is provably non-null here, and closures below
    // would widen it back to string | null.
    const activeSessionId = sessionId;

    try {
      await connection.setSessionMode({ sessionId: activeSessionId, modeId });
    } catch {
      await emit({
        type: "devin.status",
        status: "mode-unavailable",
        message: `Devin session mode "${modeId}" is not available; continuing with the session default.`,
      });
    }

    await emit({ type: "devin.status", status: "running", message: resumed ? `Resuming Devin session ${sessionId}.` : "Starting a new Devin session." });

    if (timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        void connection.cancel({ sessionId: activeSessionId }).catch(() => undefined);
      }, timeoutSec * 1000);
    }

    const promptPromise = connection.prompt({
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    if (timeoutSec > 0) {
      const deadline = (timeoutSec + graceSec) * 1000;
      const result = await Promise.race([
        promptPromise.then((response) => ({ response }) as const),
        sleep(deadline).then(() => ({ graceExpired: true }) as const),
      ]);
      if ("graceExpired" in result) {
        timedOut = true;
      } else {
        promptResponse = result.response;
      }
    } else {
      promptResponse = await promptPromise;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await sleep(250);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  const stderr = stderrChunks.join("").trim();
  const stopReason = promptResponse?.stopReason;
  const status = timedOut
    ? "timed_out"
    : failure
      ? "error"
      : stopReason === "end_turn"
        ? "finished"
        : stopReason === "cancelled"
          ? "cancelled"
          : stopReason
            ? "error"
            : "error";
  const errorMessage = timedOut
    ? "Devin run timed out."
    : (failure ??
      (status === "cancelled"
        ? "Devin turn was cancelled."
        : status === "error"
          ? (stderr || `Devin turn stopped (${stopReason ?? "unknown"}).`)
          : null));

  await emit({
    type: "devin.result",
    status,
    sessionId,
    model,
    resumed,
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.cachedTokens !== undefined
      ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens } }
      : {}),
  });

  const isError = status !== "finished";
  return {
    exitCode: isError ? 1 : 0,
    signal: null,
    timedOut,
    errorMessage,
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: sessionId ? { sessionId, cwd } : null,
    provider: "devin",
    biller: "devin",
    model,
    billingType: "subscription",
    costUsd: null,
    summary: isError ? null : firstNonEmptyLine(assistantText),
    clearSession,
    resultJson: {
      status: timedOut ? "timed_out" : status,
      devinSessionId: sessionId,
      resumed,
      model,
      engine: "acp",
      ...(usage.used !== undefined ? { usage } : {}),
      ...(stderr ? { stderr } : {}),
      ...(failure ? { error: failure } : {}),
    },
  };
}

function firstNonEmptyLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}

/**
 * Environment probe for testEnvironment: spawns `devin acp`, completes the
 * initialize handshake, and reports whether the agent asked for auth.
 * A passing probe emits the hello_probe check code Paperclip's lifecycle
 * gate requires to mark an adapter "verified".
 */
export async function probeDevinAcp(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; authRequired: boolean; detail: string }> {
  const child = spawn(command, ["acp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        extMethod: async (method) => {
          if (method === DEVIN_DIAGNOSTICS_METHOD) return {};
          throw RequestError.methodNotFound(method);
        },
        extNotification: async () => {},
      }),
      stream,
    );
    const init = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "paperclip-devin-adapter", title: "Paperclip Devin Adapter", version: "0.1.0" },
      }),
      sleep(timeoutMs).then(() => {
        throw new Error(`devin acp did not answer initialize within ${timeoutMs}ms`);
      }),
    ]);
    // A real hello probe: session/new is the cheapest request that exercises
    // credentials. authMethods merely lists supported methods — a logged-in
    // devin advertises them too, so auth is only "required" when the agent
    // actually refuses (JSON-RPC -32000).
    try {
      await Promise.race([
        connection.newSession({ cwd, mcpServers: [] }),
        sleep(timeoutMs).then(() => {
          throw new Error(`devin acp did not answer session/new within ${timeoutMs}ms`);
        }),
      ]);
    } catch (err) {
      if (err instanceof RequestError && err.code === -32000) {
        return { ok: true, authRequired: true, detail: err.message };
      }
      throw err;
    }
    return {
      ok: true,
      authRequired: false,
      detail: `protocol ${String(init.protocolVersion)}, agent ${init.agentInfo?.name ?? "unknown"} ${init.agentInfo?.version ?? ""}`.trim(),
    };
  } catch (err) {
    return { ok: false, authRequired: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function acpInvocationMeta(options: Pick<AcpExecuteOptions, "command" | "model">): Pick<AdapterInvocationMeta, "commandArgs"> {
  return {
    commandArgs: ["acp", ...(options.model ? ["--model", options.model] : [])],
  };
}
