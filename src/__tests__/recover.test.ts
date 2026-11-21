import { describe, expect, it } from "vitest";
import { parseArgs } from "../bin/devin-paperclip-recover.js";
import {
  buildResolvePayload,
  findReconciliationHolds,
  holdSourceRunId,
  isReconciliationHold,
  RecoverUsageError,
  selectHold,
  type IssueRecoveryAction,
} from "../server/recover.js";

const ACTION_ID = "eb5fe4ad-0000-4000-8000-000000000001";
const RUN_ID = "671fc35c-995b-4987-a0af-796cd04e7647";

const hold = (overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction => ({
  id: ACTION_ID,
  cause: "legacy_execution_requires_reconciliation",
  status: "active",
  evidence: { runId: RUN_ID, automaticRecovery: { replay: "blocked" } },
  createdAt: "2026-11-11T10:06:09Z",
  ...overrides,
});

describe("isReconciliationHold", () => {
  it("matches an active reconciliation hold", () => {
    expect(isReconciliationHold(hold())).toBe(true);
    expect(isReconciliationHold(hold({ status: "escalated" }))).toBe(true);
  });

  it("keeps resolved rows whose replay is still blocked", () => {
    expect(isReconciliationHold(hold({ status: "resolved" }))).toBe(true);
  });

  it("ignores other causes and fully settled rows", () => {
    expect(isReconciliationHold(hold({ cause: "workspace_restore_recovery" }))).toBe(false);
    expect(
      isReconciliationHold(
        hold({ status: "resolved", evidence: { runId: RUN_ID, automaticRecovery: {} } }),
      ),
    ).toBe(false);
  });
});

describe("findReconciliationHolds", () => {
  it("filters to reconciliation holds, newest first", () => {
    const older = hold({ id: "eb5fe4ad-0000-4000-8000-000000000002", createdAt: "2026-11-10T09:00:00Z" });
    const unrelated = hold({ cause: "workspace_restore_recovery", createdAt: "2026-11-12T09:00:00Z" });
    const holds = findReconciliationHolds({ actions: [older, unrelated, hold()] });
    expect(holds.map((h) => h.id)).toEqual([ACTION_ID, older.id]);
  });
});

describe("holdSourceRunId", () => {
  it("prefers evidence.runId and falls back to sourceRunId", () => {
    expect(holdSourceRunId(hold())).toBe(RUN_ID);
    expect(
      holdSourceRunId(hold({ evidence: { sourceRunId: RUN_ID } })),
    ).toBe(RUN_ID);
    expect(holdSourceRunId(hold({ evidence: {} }))).toBeNull();
    expect(holdSourceRunId(hold({ evidence: null }))).toBeNull();
  });
});

describe("selectHold", () => {
  const other = hold({ id: "eb5fe4ad-0000-4000-8000-000000000003" });

  it("returns the single open hold without an id", () => {
    expect(selectHold([hold()])).toMatchObject({ id: ACTION_ID });
  });

  it("selects by --action-id and rejects unknown ids", () => {
    expect(selectHold([hold(), other], other.id)).toMatchObject({ id: other.id });
    expect(() => selectHold([hold()], other.id)).toThrow(RecoverUsageError);
  });

  it("refuses to guess between multiple holds", () => {
    expect(() => selectHold([hold(), other])).toThrow(/--action-id/);
  });

  it("reports when nothing holds the issue", () => {
    expect(() => selectHold([])).toThrow(/No unresolved/);
  });

  it("requires --action-id for a hold recorded for another failure", () => {
    const timedOut = hold({
      evidence: { runId: RUN_ID, originalFailureCode: "timeout" },
    });
    expect(() => selectHold([timedOut])).toThrow(/recorded for timeout/);
    expect(selectHold([timedOut], ACTION_ID)).toMatchObject({ id: ACTION_ID });
    const lost = hold({
      evidence: { runId: RUN_ID, originalFailureCode: "process_lost" },
    });
    expect(selectHold([lost])).toMatchObject({ id: ACTION_ID });
  });

  it("refuses a settled hold while another recovery action is active", () => {
    const settled = hold({ status: "resolved" });
    const active = hold({ id: other.id, cause: "configuration_incomplete" });
    expect(() => selectHold([settled], undefined, active)).toThrow(/is active on this issue/);
    expect(() => selectHold([settled], ACTION_ID, active)).toThrow(/is active on this issue/);
    expect(selectHold([settled], undefined, null)).toMatchObject({ id: ACTION_ID });
    expect(selectHold([hold()], undefined, hold())).toMatchObject({ id: ACTION_ID });
  });
});

describe("buildResolvePayload", () => {
  const base = {
    hold: hold(),
    actionOutcome: "not_performed" as const,
    outcomeEvidence: "Server restarted at 10:05; both devin child processes were gone.",
  };

  it("builds the restored+todo reconciliation decision", () => {
    expect(buildResolvePayload(base)).toEqual({
      actionId: ACTION_ID,
      outcome: "restored",
      sourceIssueStatus: "todo",
      executionReconciliation: {
        runId: RUN_ID,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: base.outcomeEvidence,
      },
    });
  });

  it("rejects invalid outcomes and thin evidence", () => {
    expect(() =>
      buildResolvePayload({ ...base, actionOutcome: "guessed" as never }),
    ).toThrow(/--action-outcome/);
    expect(() =>
      buildResolvePayload({ ...base, outcomeEvidence: "died" }),
    ).toThrow(/outcome-evidence/);
  });

  it("refuses holds with no recorded source run", () => {
    expect(() =>
      buildResolvePayload({ ...base, hold: hold({ evidence: {} }) }),
    ).toThrow(/source run id/);
  });
});

describe("cli parseArgs", () => {
  const issueId = "11111111-2222-3333-4444-555555555555";

  it("parses a resolve invocation", () => {
    const args = parseArgs([
      "resolve", issueId,
      "--action-outcome", "not_performed",
      "--outcome-evidence", "Server restarted; processes gone.",
      "--note", "triaged on the board",
      "--dry-run",
    ]);
    expect(args).toMatchObject({
      command: "resolve",
      issueId,
      actionOutcome: "not_performed",
      outcomeEvidence: "Server restarted; processes gone.",
      note: "triaged on the board",
      dryRun: true,
    });
  });

  it("does not consume a following flag as a flag's value", () => {
    expect(() => parseArgs(["resolve", issueId, "--note", "--dry-run"]))
      .toThrow(/--note requires a value/);
    expect(() => parseArgs(["resolve", issueId, "--action-outcome", "--dry-run"]))
      .toThrow(/--action-outcome requires a value/);
    expect(() => parseArgs(["resolve", issueId, "--note"]))
      .toThrow(/--note requires a value/);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["list", issueId, "--bogus"])).toThrow(/Unknown option/);
  });

  it("accepts --api-key-env to keep the key out of argv", () => {
    expect(parseArgs(["list", issueId, "--api-key-env", "MY_BOARD_KEY"]))
      .toMatchObject({ apiKeyEnv: "MY_BOARD_KEY" });
  });
});
