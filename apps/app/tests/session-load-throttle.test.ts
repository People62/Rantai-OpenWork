import { describe, expect, test } from "bun:test";

import {
  SESSION_LOAD_MIN_INTERVAL_MS,
  shouldSkipSessionLoad,
} from "../src/react-app/shell/session-load-throttle";

const gate = (over: Partial<Parameters<typeof shouldSkipSessionLoad>[0]> = {}) =>
  shouldSkipSessionLoad({
    attempt: 0,
    inFlight: false,
    lastStartedAt: undefined,
    now: 100_000,
    ...over,
  });

describe("shouldSkipSessionLoad", () => {
  test("allows the first load for a workspace", () => {
    expect(gate()).toBe(false);
  });

  test("blocks while a request is still in flight", () => {
    expect(gate({ inFlight: true })).toBe(true);
  });

  test("blocks a fresh load inside the minimum interval", () => {
    expect(gate({ lastStartedAt: 100_000 - 1 })).toBe(true);
    expect(gate({ lastStartedAt: 100_000 - (SESSION_LOAD_MIN_INTERVAL_MS - 1) })).toBe(true);
  });

  test("allows a fresh load once the interval has passed", () => {
    expect(gate({ lastStartedAt: 100_000 - SESSION_LOAD_MIN_INTERVAL_MS })).toBe(false);
    expect(gate({ lastStartedAt: 100_000 - 60_000 })).toBe(false);
  });

  test("this is the defect the old guard had: a settled request no longer throttles", () => {
    // Old behaviour deleted the timestamp in `finally`, so a request that
    // finished in 5ms left nothing behind and the next call went straight
    // through. The interval must survive completion.
    expect(gate({ inFlight: false, lastStartedAt: 100_000 - 5 })).toBe(true);
  });

  test("lets internal retries through regardless of the interval", () => {
    expect(gate({ attempt: 1, lastStartedAt: 100_000 - 5 })).toBe(false);
    expect(gate({ attempt: 4, lastStartedAt: 100_000 })).toBe(false);
  });

  test("still blocks a retry that would run concurrently", () => {
    expect(gate({ attempt: 2, inFlight: true })).toBe(true);
  });

  test("honours a custom interval", () => {
    expect(gate({ lastStartedAt: 100_000 - 500, minIntervalMs: 1_000 })).toBe(true);
    expect(gate({ lastStartedAt: 100_000 - 1_500, minIntervalMs: 1_000 })).toBe(false);
  });

  test("does not lock out loading when the clock jumps backwards", () => {
    expect(gate({ lastStartedAt: 100_000 + 30_000 })).toBe(false);
  });

  test("ignores a malformed timestamp", () => {
    expect(gate({ lastStartedAt: Number.NaN })).toBe(false);
  });
});
