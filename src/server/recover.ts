/**
 * Operator-side recovery for `devin_local` runs lost to a Paperclip server
 * restart (`errorCode: "process_lost"`).
 *
 * A killed adapter never returns, so it cannot stamp the
 * conversation-continuation policy that keeps a failed turn out of
 * reconciliation (`resultJson` is merged only when `execute()` settles).
 * Paperclip therefore parks the issue behind a
 * `legacy_execution_requires_reconciliation` hold with
 * `automaticRecovery.replay: "blocked"` — retries, comments, and status
 * changes all defer until a board operator records the reconciliation.
 *
 * This module implements the workaround from the README as code:
 * `GET /api/issues/:id/recovery-actions` picks the hold and
 * `POST /api/issues/:id/recovery-actions/resolve` restores the issue to
 * `todo` with an `executionReconciliation` decision. `deliverReconciledExecutions`
 * then wakes the assignee with `forceFreshSession: true`, so the next turn
 * starts a new Devin session instead of resuming the lost one.
 *
 * The upstream fix — letting external adapters declare conversation-turn
 * semantics — belongs in `@paperclipai/server`; this stays useful until it
 * lands.
 *
 * @module
 */

/** Recovery-action `cause` the watchdog records for a lost legacy run. */
export const RECONCILIATION_HOLD_CAUSE = "legacy_execution_requires_reconciliation";

/** Run `errorCode` this tool exists for: the server died mid-run. */
export const PROCESS_LOST_ERROR_CODE = "process_lost";

/** Subset of `issue_recovery_actions` rows returned by the read model. */
export interface IssueRecoveryAction {
  id: string;
  cause: string | null;
  status: string;
  evidence?: {
    runId?: string;
    sourceRunId?: string;
    originalFailureCode?: string;
    automaticRecovery?: { replay?: string };
    executionReconciliation?: unknown;
  } | null;
  nextAction?: string | null;
  outcome?: string | null;
  createdAt?: string;
}

/** Response shape of `GET /api/issues/:id/recovery-actions`. */
export interface IssueRecoveryActionsResponse {
  active?: IssueRecoveryAction | null;
  actions?: IssueRecoveryAction[];
}

export type ReconciliationActionOutcome = "completed" | "not_performed" | "mixed";

export const RECONCILIATION_ACTION_OUTCOMES: readonly ReconciliationActionOutcome[] = [
  "completed",
  "not_performed",
  "mixed",
];

/** `POST /issues/:id/recovery-actions/resolve` body for the restore path. */
export interface ResolveRecoveryActionPayload {
  actionId: string;
  outcome: "restored";
  sourceIssueStatus: "todo";
  resolutionNote?: string;
  executionReconciliation: {
    runId: string;
    providerStopped: true;
    actionOutcome: ReconciliationActionOutcome;
    outcomeEvidence: string;
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOLD_STATUSES = new Set(["active", "escalated"]);

/**
 * True when the action is the process_lost hold this tool resolves: the
 * reconciliation cause, still holding the issue — either unresolved
 * (`active`/`escalated`) or a resolved row whose `replay: "blocked"`
 * evidence the execution blocker keeps as an effective hold.
 */
export function isReconciliationHold(action: IssueRecoveryAction): boolean {
  if (action.cause !== RECONCILIATION_HOLD_CAUSE) return false;
  if (HOLD_STATUSES.has(action.status)) return true;
  return action.evidence?.automaticRecovery?.replay === "blocked";
}

/**
 * Reconciliation holds on an issue, newest first. The GET response puts the
 * active action first followed by retained holds; sorting by `createdAt`
 * keeps `list` output and `--action-id`-less resolution deterministic.
 */
export function findReconciliationHolds(
  response: IssueRecoveryActionsResponse,
): IssueRecoveryAction[] {
  const holds = (response.actions ?? []).filter(isReconciliationHold);
  return holds.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
}

/** Run id the resolve route reconciles against (`evidence.runId ?? evidence.sourceRunId`). */
export function holdSourceRunId(action: IssueRecoveryAction): string | null {
  const runId = action.evidence?.runId ?? action.evidence?.sourceRunId;
  return typeof runId === "string" && runId ? runId : null;
}

/** Failure code recorded on the hold, or `null` when the server did not record one. */
export function holdFailureCode(action: IssueRecoveryAction): string | null {
  const code = action.evidence?.originalFailureCode;
  return typeof code === "string" && code ? code : null;
}

export class RecoverUsageError extends Error {}

/**
 * Pick the hold to resolve. `actionId`, when given, must name a matching
 * hold; otherwise exactly one hold must exist — ambiguity is an operator
 * decision, never a guess — and it must not be recorded for a failure other
 * than `process_lost`. A settled (`replay: "blocked"`) hold can only be
 * restored while no other recovery action is active on the issue.
 */
export function selectHold(
  holds: IssueRecoveryAction[],
  actionId?: string,
  active?: IssueRecoveryAction | null,
): IssueRecoveryAction {
  const hold = pickHold(holds, actionId);
  if (active && active.id !== hold.id && !HOLD_STATUSES.has(hold.status)) {
    throw new RecoverUsageError(
      `Recovery action ${active.id} (${active.cause ?? "unknown cause"}) is active on this issue; ` +
        `Paperclip will not restore settled hold ${hold.id} until it is resolved.`,
    );
  }
  return hold;
}

function pickHold(holds: IssueRecoveryAction[], actionId?: string): IssueRecoveryAction {
  if (actionId) {
    const match = holds.find((hold) => hold.id === actionId);
    if (!match) {
      throw new RecoverUsageError(
        `No unresolved execution-reconciliation hold ${actionId} on this issue.`,
      );
    }
    return match;
  }
  if (holds.length === 0) {
    throw new RecoverUsageError(
      "No unresolved execution-reconciliation holds on this issue.",
    );
  }
  if (holds.length > 1) {
    const ids = holds.map((hold) => `  ${hold.id} (run ${holdSourceRunId(hold) ?? "?"})`).join("\n");
    throw new RecoverUsageError(
      `${holds.length} reconciliation holds found; re-run with --action-id:\n${ids}`,
    );
  }
  const hold = holds[0]!;
  const failureCode = holdFailureCode(hold);
  if (failureCode && failureCode !== PROCESS_LOST_ERROR_CODE) {
    throw new RecoverUsageError(
      `Hold ${hold.id} was recorded for ${failureCode}, not ${PROCESS_LOST_ERROR_CODE}; ` +
        "inspect the run, then re-run with --action-id to reconcile it anyway.",
    );
  }
  return hold;
}

/**
 * Build the `resolve` request body for the conversation-resume path:
 * `restored` + `todo` is the only outcome the server accepts alongside an
 * `executionReconciliation` decision, and the decision's `runId` must equal
 * the hold's recorded source run.
 */
export function buildResolvePayload(input: {
  hold: IssueRecoveryAction;
  actionOutcome: ReconciliationActionOutcome;
  outcomeEvidence: string;
  resolutionNote?: string;
}): ResolveRecoveryActionPayload {
  const { hold, actionOutcome, outcomeEvidence, resolutionNote } = input;
  if (!RECONCILIATION_ACTION_OUTCOMES.includes(actionOutcome)) {
    throw new RecoverUsageError(
      `--action-outcome must be one of: ${RECONCILIATION_ACTION_OUTCOMES.join(", ")}`,
    );
  }
  if (!UUID_RE.test(hold.id)) {
    throw new RecoverUsageError(`Recovery action id is not a uuid: ${hold.id}`);
  }
  const runId = holdSourceRunId(hold);
  if (!runId || !UUID_RE.test(runId)) {
    throw new RecoverUsageError(
      "The recovery hold does not record its source run id; resolve it from the board UI instead.",
    );
  }
  const evidence = outcomeEvidence.trim();
  if (evidence.length < 20) {
    throw new RecoverUsageError(
      "--outcome-evidence must describe what was observed (at least 20 characters).",
    );
  }
  return {
    actionId: hold.id,
    outcome: "restored",
    sourceIssueStatus: "todo",
    ...(resolutionNote ? { resolutionNote } : {}),
    executionReconciliation: {
      runId,
      providerStopped: true,
      actionOutcome,
      outcomeEvidence: evidence,
    },
  };
}

/** Minimal authenticated JSON call against the Paperclip API. */
export async function apiJson<T>(
  baseUrl: string,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}
