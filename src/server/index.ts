/**
 * Server-side runtime for the `devin_local` Paperclip adapter.
 *
 * Implements the adapter contract: `execute` runs one Devin turn per
 * heartbeat (CLI engine via `devin -p`, or ACP engine via `devin acp`),
 * `testEnvironment` runs pre-flight checks (CLI presence, auth, cwd),
 * `sessionCodec` persists and resumes Devin session ids, and
 * `listDevinModels` enumerates models from `devin models list`.
 * `getConfigSchema` drives the agent-config form in the Paperclip UI and
 * `createServerAdapter` assembles the full `ServerAdapterModule`.
 *
 * Requires Node.js on a host where `devin auth login` has been completed
 * for the Paperclip server's OS user.
 *
 * @module
 */
import type { AdapterConfigSchema, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./session.js";
import { listDevinSkills, syncDevinSkillsSnapshot } from "./skills.js";
import { listDevinModels } from "./models.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";
export { listDevinModels } from "./models.js";

/**
 * Config schema driving the agent-config form for `devin_local` agents —
 * command, cwd, model, engine (cli/acp), permissionMode, sandboxing,
 * timeouts, and related fields.
 */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "command",
        label: "Devin command",
        type: "text",
        default: "devin",
        hint: "Devin CLI binary name or absolute path.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute directory Devin works in. Defaults to the Paperclip workspace for the run.",
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        default: "swe-2-high",
        options: models.map((m) => ({ value: m.id, label: m.label })),
        hint: "Devin model id. Any id from `devin models list` works.",
      },
      {
        key: "engine",
        label: "Engine",
        type: "select",
        default: "cli",
        options: [
          { value: "cli", label: "cli — `devin -p` one-shot per heartbeat" },
          { value: "acp", label: "acp — `devin acp` structured session" },
        ],
        hint: "acp streams thinking, tool calls, and token usage into the run transcript and resumes sessions via session/load.",
      },
      {
        key: "acpMode",
        label: "ACP session mode",
        type: "text",
        hint: "Optional Devin ACP mode id (ask, plan, smart, accept-edits, bypass). Defaults to a mapping from permissionMode. ACP engine only.",
      },
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "select",
        default: "smart",
        options: [
          { value: "auto", label: "auto — approve read-only tools" },
          { value: "accept-edits", label: "accept-edits — also approve workspace edits" },
          { value: "smart", label: "smart — approve actions judged safe" },
          { value: "dangerous", label: "dangerous — approve everything" },
        ],
        hint: "Devin --permission-mode. 'dangerous' auto-approves every tool call; use only on trusted hosts.",
      },
      {
        key: "sandbox",
        label: "Sandbox exec tool",
        type: "toggle",
        default: false,
        hint: "Pass --sandbox so exec-tool processes run sandboxed (macOS seatbelt / Linux bwrap).",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Optional file whose contents are prepended to the run prompt.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional heartbeat prompt template rendered with {{agentId}}, {{runId}}, {{context.*}}, etc.",
      },
      {
        key: "timeoutSec",
        label: "Timeout (sec)",
        type: "number",
        default: 0,
        hint: "Hard timeout for one Devin turn. 0 = unlimited.",
      },
      {
        key: "graceSec",
        label: "Grace (sec)",
        type: "number",
        default: 20,
        hint: "Grace period before the process is force-killed after timeout.",
      },
    ],
  };
}

/**
 * Assemble the full server adapter module for `devin_local`: execution,
 * environment checks, session persistence, skills sync, model listing,
 * and the config schema above.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    listSkills: listDevinSkills,
    syncSkills: syncDevinSkillsSnapshot,
    models,
    listModels: listDevinModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    runtimeToolDelivery: "environment",
    agentConfigurationDoc,
    getConfigSchema,
  };
}
