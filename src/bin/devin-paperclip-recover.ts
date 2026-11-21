#!/usr/bin/env node
/**
 * `devin-paperclip-recover` — release a `devin_local` issue stuck behind a
 * `legacy_execution_requires_reconciliation` hold after a Paperclip server
 * restart lost the run (`process_lost`).
 *
 *   list    Show unresolved reconciliation holds on an issue.
 *   resolve Record the execution reconciliation and restore the issue to
 *           `todo`; the assignee wakes on a fresh Devin session.
 *
 * Auth: `Authorization: Bearer <board api key>` via `PAPERCLIP_API_KEY`
 * (or `--api-key-env <name>`; `--api-key` works but stays visible in
 * process listings). The key is optional for a loopback API base, which
 * Paperclip's `local_trusted` mode already treats as the board, and is only
 * sent to other hosts over https. API base via `--api-base` or `PAPERCLIP_API_URL`
 * (default http://localhost:3100) — the same env vars the `paperclipai`
 * CLI uses.
 *
 * @module
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  apiJson,
  buildResolvePayload,
  findReconciliationHolds,
  holdFailureCode,
  isLoopbackApiBase,
  holdSourceRunId,
  RECONCILIATION_ACTION_OUTCOMES,
  RecoverUsageError,
  selectHold,
  type IssueRecoveryActionsResponse,
  type ReconciliationActionOutcome,
} from "../server/recover.js";

const USAGE = `devin-paperclip-recover — reconcile devin_local runs lost to a server restart

Usage:
  devin-paperclip-recover list <issueId>
  devin-paperclip-recover resolve <issueId> --action-outcome <outcome> --outcome-evidence <text>

Options:
  --action-outcome <outcome>   completed | not_performed | mixed (resolve, required)
  --outcome-evidence <text>    What was observed for the lost run, >= 20 chars (resolve, required)
  --action-id <uuid>           Resolve this hold when several are open (resolve)
  --note <text>                Resolution note recorded on the action (resolve)
  --dry-run                    Print the resolve payload without posting it (resolve)
  --api-base <url>             Paperclip API base (env PAPERCLIP_API_URL; default http://localhost:3100)
  --api-key-env <name>         Env var holding the board API key (default PAPERCLIP_API_KEY;
                               optional for a loopback API base, https required for remote)
  --api-key <key>              Board API key directly; visible in process listings, prefer --api-key-env
  --json                       Machine-readable output
  -h, --help                   Show this help
`;

interface CliArgs {
  command: string | null;
  issueId: string | null;
  actionOutcome: string | null;
  outcomeEvidence: string | null;
  actionId: string | null;
  note: string | null;
  dryRun: boolean;
  apiBase: string | null;
  apiKey: string | null;
  apiKeyEnv: string | null;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    issueId: null,
    actionOutcome: null,
    outcomeEvidence: null,
    actionId: null,
    note: null,
    dryRun: false,
    apiBase: null,
    apiKey: null,
    apiKeyEnv: null,
    json: false,
    help: false,
  };
  const positional: string[] = [];
  const valueFlags: Record<string, keyof CliArgs> = {
    "--action-outcome": "actionOutcome",
    "--outcome-evidence": "outcomeEvidence",
    "--action-id": "actionId",
    "--note": "note",
    "--api-base": "apiBase",
    "--api-key": "apiKey",
    "--api-key-env": "apiKeyEnv",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.includes("=") && arg.slice(0, arg.indexOf("=")) in valueFlags) {
      const flag = arg.slice(0, arg.indexOf("="));
      args[valueFlags[flag]!] = arg.slice(flag.length + 1) as never;
    } else if (arg in valueFlags) {
      const value = argv[i + 1];
      // A flag-like token (`--dry-run`, `--note=<text>`) means the value was
      // omitted; dash-led prose such as "- verified the process stopped" is kept.
      if (value === undefined || /^-\S*$/.test(value) || /^--[A-Za-z][\w-]*=/.test(value)) {
        throw new RecoverUsageError(`${arg} requires a value (use ${arg}=<value> for dash-led text)`);
      }
      i++;
      args[valueFlags[arg]!] = value as never;
    } else if (arg.startsWith("--")) {
      throw new RecoverUsageError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  [args.command, args.issueId] = [positional[0] ?? null, positional[1] ?? null];
  if (positional.length > 2) {
    throw new RecoverUsageError(`Unexpected argument: ${positional[2]}`);
  }
  return args;
}

function resolveConnection(args: CliArgs): { apiBase: string; apiKey: string | null } {
  const apiBase =
    args.apiBase ?? process.env.PAPERCLIP_API_URL?.trim() ?? "http://localhost:3100";
  const apiKey =
    args.apiKey ?? process.env[args.apiKeyEnv ?? "PAPERCLIP_API_KEY"]?.trim() ?? null;
  const loopback = isLoopbackApiBase(apiBase);
  if (!apiKey && !loopback) {
    throw new RecoverUsageError(
      `A board API key is required for ${apiBase}. Set ${args.apiKeyEnv ?? "PAPERCLIP_API_KEY"} or pass --api-key-env/--api-key.`,
    );
  }
  if (apiKey && !loopback && new URL(apiBase).protocol !== "https:") {
    throw new RecoverUsageError(
      `Refusing to send the board API key to ${apiBase} over plain HTTP; use an https:// API base.`,
    );
  }
  return { apiBase, apiKey: apiKey || null };
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

async function listCommand(args: CliArgs): Promise<void> {
  const { apiBase, apiKey } = resolveConnection(args);
  const data = await apiJson<IssueRecoveryActionsResponse>(
    apiBase,
    apiKey,
    "GET",
    `/api/issues/${args.issueId}/recovery-actions`,
  );
  const holds = findReconciliationHolds(data);
  if (args.json) {
    print(holds, true);
    return;
  }
  if (holds.length === 0) {
    print("No unresolved execution-reconciliation holds on this issue.", false);
    return;
  }
  const rows = holds.map((hold) => ({
    actionId: hold.id,
    status: hold.status,
    runId: holdSourceRunId(hold) ?? "(none)",
    failureCode: holdFailureCode(hold) ?? "-",
    replay: hold.evidence?.automaticRecovery?.replay ?? "-",
    nextAction: hold.nextAction ?? "",
  }));
  console.table(rows);
}

async function resolveCommand(args: CliArgs): Promise<void> {
  if (!args.actionOutcome) {
    throw new RecoverUsageError(
      `resolve requires --action-outcome (${RECONCILIATION_ACTION_OUTCOMES.join(" | ")})`,
    );
  }
  if (!args.outcomeEvidence) {
    throw new RecoverUsageError(
      "resolve requires --outcome-evidence describing what was observed for the lost run.",
    );
  }
  const { apiBase, apiKey } = resolveConnection(args);
  const data = await apiJson<IssueRecoveryActionsResponse>(
    apiBase,
    apiKey,
    "GET",
    `/api/issues/${args.issueId}/recovery-actions`,
  );
  const hold = selectHold(
    findReconciliationHolds(data),
    args.actionId ?? undefined,
    data.active,
  );
  const payload = buildResolvePayload({
    hold,
    actionOutcome: args.actionOutcome as ReconciliationActionOutcome,
    outcomeEvidence: args.outcomeEvidence,
    resolutionNote: args.note ?? undefined,
  });
  if (args.dryRun) {
    print(payload, true);
    return;
  }
  const result = await apiJson<unknown>(
    apiBase,
    apiKey,
    "POST",
    `/api/issues/${args.issueId}/recovery-actions/resolve`,
    payload,
  );
  if (args.json) {
    print(result, true);
    return;
  }
  print(
    `Reconciled run ${payload.executionReconciliation.runId} on action ${payload.actionId}.\n` +
      "The issue is restored to todo; the assignee wakes on a fresh Devin session.",
    false,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    print(USAGE, false);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  if (!args.issueId) {
    throw new RecoverUsageError("An issue id is required.");
  }
  if (args.command === "list") await listCommand(args);
  else if (args.command === "resolve") await resolveCommand(args);
  else throw new RecoverUsageError(`Unknown command: ${args.command}`);
}

const invokedAsScript =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`devin-paperclip-recover: ${message}\n`);
    process.exitCode = error instanceof RecoverUsageError ? 2 : 1;
  });
}
