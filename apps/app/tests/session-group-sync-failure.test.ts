import { describe, expect, test } from "bun:test";

import {
  SESSION_GROUP_SYNC_FAILURE_WINDOW_MS,
  describeSessionGroupSyncFailure,
  shouldReportSessionGroupFailure,
} from "../src/react-app/domains/session/sidebar/session-group-sync-failure";

describe("describeSessionGroupSyncFailure", () => {
  test("uses the error message when there is one", () => {
    expect(describeSessionGroupSyncFailure(new Error("Request timed out."))).toBe("Request timed out.");
  });

  test("accepts a plain string", () => {
    expect(describeSessionGroupSyncFailure("offline")).toBe("offline");
  });

  test("falls back for empty or unusable values", () => {
    const fallback = "The server did not accept the change.";
    expect(describeSessionGroupSyncFailure(new Error("   "))).toBe(fallback);
    expect(describeSessionGroupSyncFailure("")).toBe(fallback);
    expect(describeSessionGroupSyncFailure(null)).toBe(fallback);
    expect(describeSessionGroupSyncFailure({ code: 500 })).toBe(fallback);
  });
});

const gate = (over: Partial<Parameters<typeof shouldReportSessionGroupFailure>[0]> = {}) =>
  shouldReportSessionGroupFailure({
    message: "Request timed out.",
    lastMessage: undefined,
    lastReportedAt: undefined,
    now: 50_000,
    ...over,
  });

describe("shouldReportSessionGroupFailure", () => {
  test("reports the first failure", () => {
    expect(gate()).toBe(true);
  });

  test("stays quiet for the same message inside the window", () => {
    expect(gate({ lastMessage: "Request timed out.", lastReportedAt: 50_000 - 1 })).toBe(false);
  });

  test("reports again once the window has passed", () => {
    expect(
      gate({
        lastMessage: "Request timed out.",
        lastReportedAt: 50_000 - SESSION_GROUP_SYNC_FAILURE_WINDOW_MS,
      }),
    ).toBe(true);
  });

  test("always reports a different message", () => {
    expect(gate({ message: "Offline.", lastMessage: "Request timed out.", lastReportedAt: 50_000 })).toBe(true);
  });

  test("ignores a blank message", () => {
    expect(gate({ message: "   " })).toBe(false);
  });

  test("does not stay silent when the clock jumps backwards", () => {
    expect(gate({ lastMessage: "Request timed out.", lastReportedAt: 90_000 })).toBe(true);
  });

  test("honours a custom window", () => {
    expect(gate({ lastMessage: "Request timed out.", lastReportedAt: 49_500, windowMs: 1_000 })).toBe(false);
    expect(gate({ lastMessage: "Request timed out.", lastReportedAt: 48_000, windowMs: 1_000 })).toBe(true);
  });
});
