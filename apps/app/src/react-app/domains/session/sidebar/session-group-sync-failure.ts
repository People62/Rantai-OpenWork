/**
 * Turning a failed session-group sync into something a person can act on.
 *
 * Group changes apply optimistically, so a failed save leaves the sidebar
 * showing an arrangement the server never accepted. Until now the only trace
 * was a console warning, which meant the work quietly disappeared on the next
 * reload. These helpers keep the reporting honest without flooding the user
 * when several mutations fail in a row.
 */

export const SESSION_GROUP_SYNC_FAILURE_WINDOW_MS = 10_000;

/** A short, user-facing reason. Falls back to a generic line for odd values. */
export function describeSessionGroupSyncFailure(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message;
  }
  if (typeof error === "string") {
    const message = error.trim();
    if (message) return message;
  }
  return "The server did not accept the change.";
}

export type SessionGroupFailureGate = {
  message: string;
  lastMessage: string | undefined;
  lastReportedAt: number | undefined;
  now: number;
  windowMs?: number;
};

/**
 * Whether this failure is worth telling the user about. Repeats of the same
 * message inside the window stay quiet: a single dropped connection can fail
 * every queued mutation, and one notice explains all of them.
 */
export function shouldReportSessionGroupFailure(input: SessionGroupFailureGate): boolean {
  if (!input.message.trim()) return false;
  if (input.lastMessage !== input.message) return true;

  const lastReportedAt = input.lastReportedAt;
  if (typeof lastReportedAt !== "number" || !Number.isFinite(lastReportedAt)) return true;

  const elapsed = input.now - lastReportedAt;
  // A backwards clock jump must not silence reporting indefinitely.
  if (elapsed < 0) return true;
  return elapsed >= (input.windowMs ?? SESSION_GROUP_SYNC_FAILURE_WINDOW_MS);
}
