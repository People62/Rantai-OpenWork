/**
 * Rate limiting for background session-list loads.
 *
 * The original guard stored a timestamp when a request started and deleted it
 * in `finally`, so its five-second window only ever covered the request's own
 * duration — a few milliseconds. It prevented parallel requests for one
 * workspace but never limited how often they could be issued, which is why a
 * remounting route could fire dozens per second.
 *
 * Separating the two concerns keeps both properties honest:
 *   - in-flight  → never two concurrent loads for the same workspace
 *   - last start → a real minimum interval between fresh loads
 *
 * Internal retries (attempt > 0) deliberately bypass the interval: they
 * continue one logical load rather than starting a new one, and their own
 * backoff already paces them.
 */

export const SESSION_LOAD_MIN_INTERVAL_MS = 5_000;

export type SessionLoadGateInput = {
  /** 0 for a fresh load, higher for the retry chain of an existing one. */
  attempt: number;
  /** True while a request for this workspace has not settled yet. */
  inFlight: boolean;
  /** When the most recent load for this workspace began, if any. */
  lastStartedAt: number | undefined;
  now: number;
  minIntervalMs?: number;
};

/**
 * Returns true when a load should be skipped. Callers that get `false` are
 * expected to record the new start time before issuing the request.
 */
export function shouldSkipSessionLoad(input: SessionLoadGateInput): boolean {
  if (input.inFlight) return true;
  if (input.attempt > 0) return false;

  const minIntervalMs = input.minIntervalMs ?? SESSION_LOAD_MIN_INTERVAL_MS;
  const lastStartedAt = input.lastStartedAt;
  if (typeof lastStartedAt !== "number" || !Number.isFinite(lastStartedAt)) return false;

  const elapsed = input.now - lastStartedAt;
  // A clock that jumped backwards must not lock loading out indefinitely.
  if (elapsed < 0) return false;
  return elapsed < minIntervalMs;
}
