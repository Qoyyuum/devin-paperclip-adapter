/**
 * Paperclip external adapter that runs the Devin CLI as a local process,
 * so a Paperclip company can hire Devin as an agent.
 *
 * This entrypoint publishes adapter metadata (`type`, `label`, `models`,
 * `agentConfigurationDoc`) and re-exports `createServerAdapter`. Each
 * Paperclip heartbeat runs one Devin turn via `devin -p`; the Devin
 * conversation is resumed across heartbeats with `devin -r <sessionId>`.
 *
 * The server-side runtime lives in
 * `@paperclip/devin-cli-adapter/server`; transcript rendering lives in
 * `@paperclip/devin-cli-adapter/ui-parser`.
 *
 * @example
 * ```ts
 * import { createServerAdapter, type } from "@paperclip/devin-cli-adapter";
 *
 * const adapter = createServerAdapter();
 * adapter.type === "devin_local";
 * ```
 *
 * @module
 */
export const type = "devin_local";
export const label = "Devin (local CLI)";

export const models = [
  { id: "swe-2-high", label: "SWE-2 High (free)" },
  { id: "swe-2-medium", label: "SWE-2 Medium (free)" },
  { id: "swe-2-max", label: "SWE-2 Max (free)" },
  { id: "adaptive", label: "Adaptive" },
];

export const agentConfigurationDoc: string = `# devin_local agent configuration

Adapter: devin_local

Runs the Devin CLI ("devin -p") as a local child process on the Paperclip
host, using the operator's Devin account. Each Paperclip heartbeat is one
Devin turn; the Devin conversation is resumed across heartbeats with
"devin -r <sessionId>" so the agent keeps full context between wakes.

Use when:
- You want a Devin agent working in a local workspace checked out on the
  Paperclip host
- You want to use the free SWE-2 models (swe-2-high is the default)
- You want Paperclip to own issue/task state while Devin does the code work

Don't use when:
- You want Devin Cloud sessions (remote sandboxes) — this adapter is local-only
- The devin CLI is not installed or not logged in on the Paperclip host
- You need a one-off script run (use the "process" adapter instead)

Core fields:
- engine (string, optional): cli | acp (default "cli"). "cli" runs
  "devin -p" one-shot per heartbeat. "acp" drives "devin acp" over the
  Agent Client Protocol: structured thinking/tool-call/usage events in the
  transcript, and session resume via ACP session/load.
- acpMode (string, optional): Devin ACP session mode id for the acp
  engine (ask, plan, smart, accept-edits, bypass). Defaults to a mapping
  from permissionMode (auto/smart → smart, accept-edits → accept-edits,
  dangerous → bypass).
- cwd (string, optional): absolute working directory for the Devin session.
  Defaults to the Paperclip workspace for the run.
- command (string, optional): Devin CLI binary name or path (default "devin").
- model (string, optional): Devin model id (default "swe-2-high"). Any id from
  "devin models list" works, e.g. "claude-sonnet-4", "swe-2-medium-lightning".
- permissionMode (string, optional): auto | accept-edits | smart | dangerous
  (default "smart"). Use "dangerous" only for trusted, sandboxed hosts —
  it auto-approves every tool call including arbitrary shell commands.
- sandbox (boolean, optional): pass --sandbox to sandbox exec-tool processes
  (macOS seatbelt / Linux bwrap; default false).
- instructionsFilePath (string, optional): agent instructions file prepended
  to the run prompt.
- promptTemplate (string, optional): heartbeat prompt template.
- timeoutSec (number, optional): hard timeout for a Devin turn (default 0 =
  unlimited).
- graceSec (number, optional): grace period before force-kill (default 20).
- extraArgs (string[], optional): additional CLI args appended to the
  invocation.
- env (object, optional): extra environment variables for the Devin process.

Notes:
- Sessions are stored per working directory by the Devin CLI. The adapter
  records the Devin session id after each run and resumes it on the next
  heartbeat when the cwd still matches.
- Paperclip skills the operator selects are symlinked into ~/.agents/skills,
  a directory Devin already scans globally. The agent's cwd is never touched.
- The adapter injects PAPERCLIP_* env vars (API URL, run id, task/wake ids,
  run-scoped API key) so Devin can call the Paperclip API from its shell.
- Requires "devin auth login" to have been completed on the host; the CLI
  runs under the Paperclip server's OS user.
`;

export { createServerAdapter } from "./server/index.js";
