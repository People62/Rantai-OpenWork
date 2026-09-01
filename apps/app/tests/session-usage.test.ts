import { describe, expect, test } from "bun:test";

import {
  formatTokenCount,
  formatUsageCost,
  sessionUsageTotals,
} from "../src/react-app/domains/session/surface/session-usage";

const assistant = (cost: number, tokens: Record<string, unknown>) => ({
  info: { role: "assistant", cost, tokens },
});

describe("sessionUsageTotals", () => {
  test("reports no usage for an empty or missing transcript", () => {
    expect(sessionUsageTotals([]).hasUsage).toBe(false);
    expect(sessionUsageTotals(null).hasUsage).toBe(false);
    expect(sessionUsageTotals(undefined).totalTokens).toBe(0);
  });

  test("ignores user messages", () => {
    const totals = sessionUsageTotals([
      { info: { role: "user" } },
      assistant(0.5, { input: 100, output: 50 }),
    ]);
    expect(totals.inputTokens).toBe(100);
    expect(totals.outputTokens).toBe(50);
    expect(totals.cost).toBe(0.5);
  });

  test("counts cache reads as input and reasoning as output", () => {
    const totals = sessionUsageTotals([
      assistant(0, { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } }),
    ]);
    expect(totals.inputTokens).toBe(40);
    expect(totals.outputTokens).toBe(25);
    expect(totals.totalTokens).toBe(65);
  });

  test("sums across several assistant turns", () => {
    const totals = sessionUsageTotals([
      assistant(0.25, { input: 100, output: 10 }),
      assistant(0.75, { input: 200, output: 20 }),
    ]);
    expect(totals.totalTokens).toBe(330);
    expect(totals.cost).toBe(1);
    expect(totals.hasUsage).toBe(true);
  });

  test("survives malformed entries without producing NaN", () => {
    const totals = sessionUsageTotals([
      { info: { role: "assistant", cost: Number.NaN, tokens: { input: "x" as unknown as number } } },
      { info: { role: "assistant" } },
      {},
      assistant(0.1, { input: 5, output: 5 }),
    ]);
    expect(Number.isFinite(totals.totalTokens)).toBe(true);
    expect(totals.totalTokens).toBe(10);
    expect(totals.cost).toBeCloseTo(0.1);
  });

  test("stays quiet when a turn reports zeroes", () => {
    expect(sessionUsageTotals([assistant(0, { input: 0, output: 0 })]).hasUsage).toBe(false);
  });
});

describe("formatTokenCount", () => {
  test("formats by magnitude", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(980)).toBe("980");
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(15_400)).toBe("15k");
    expect(formatTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("formatUsageCost", () => {
  test("keeps small amounts from rounding away to zero", () => {
    expect(formatUsageCost(0.0042)).toBe("$0.0042");
    expect(formatUsageCost(0.123)).toBe("$0.123");
    expect(formatUsageCost(2.5)).toBe("$2.50");
  });

  test("returns nothing when the provider reports no cost", () => {
    expect(formatUsageCost(0)).toBe("");
    expect(formatUsageCost(Number.NaN)).toBe("");
  });
});
