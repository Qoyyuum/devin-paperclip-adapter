/**
 * Paperclip recovery contract for interrupted Devin turns.
 *
 * Each heartbeat is one resumable Devin conversation turn (`devin -r` /
 * ACP `session/load`), so a failed or timed-out turn is safe to continue
 * with a fresh message rather than requiring board reconciliation.
 * Paperclip only infers this for its built-in adapter types; external
 * adapters opt in by stamping the policy into `resultJson`.
 *
 * @module
 */

/** Must match `CONVERSATION_CONTINUATION_POLICY` in `@paperclipai/server`. */
export const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

/**
 * `resultJson` fields declaring conversation-continuation semantics for a
 * non-successful turn. Successful and cancelled turns get none: the server
 * owns the cancellation-acknowledgement contract.
 */
export function conversationContinuationFields(
  status: string,
): { conversationContinuation?: typeof CONVERSATION_CONTINUATION_POLICY } {
  return status === "error" || status === "timed_out"
    ? { conversationContinuation: CONVERSATION_CONTINUATION_POLICY }
    : {};
}
