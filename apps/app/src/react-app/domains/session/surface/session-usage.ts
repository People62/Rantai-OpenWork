/**
 * Token and cost totals for a session.
 *
 * The engine already reports `cost` and `tokens` on every assistant message,
 * and the automation runner reads them, but nothing surfaces them in chat.
 * These helpers aggregate a snapshot so the surface can show what a
 * conversation has spent.
 */

type UsageTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

type UsageMessage = {
  info?: {
    role?: string;
    cost?: number;
    tokens?: UsageTokens;
  };
};

export type SessionUsageTotals = {
  /** Tokens the model read, including cache reads. */
  inputTokens: number;
  /** Tokens the model produced, including reasoning. */
  outputTokens: number;
  /** Sum of both, which is what the summary line shows. */
  totalTokens: number;
  /** Provider-reported cost in USD. Zero when the provider reports none. */
  cost: number;
  /** False when no assistant message carried usage, so callers can stay quiet. */
  hasUsage: boolean;
};

const EMPTY_TOTALS: SessionUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
  hasUsage: false,
};

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Adds up usage across assistant messages. Unknown or malformed entries
 * contribute nothing rather than poisoning the total with NaN.
 */
export function sessionUsageTotals(messages: readonly UsageMessage[] | null | undefined): SessionUsageTotals {
  if (!Array.isArray(messages) || messages.length === 0) return EMPTY_TOTALS;

  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let hasUsage = false;

  for (const message of messages) {
    const info = message?.info;
    if (info?.role !== "assistant") continue;

    const tokens = info.tokens;
    const input = finiteOrZero(tokens?.input) + finiteOrZero(tokens?.cache?.read);
    const output = finiteOrZero(tokens?.output) + finiteOrZero(tokens?.reasoning);
    const messageCost = finiteOrZero(info.cost);

    if (input > 0 || output > 0 || messageCost > 0) hasUsage = true;

    inputTokens += input;
    outputTokens += output;
    cost += messageCost;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cost,
    hasUsage,
  };
}

/** Compact token count: 980, 1.2k, 15k, 1.4M. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Cost in USD. Small amounts keep four decimals so a cheap turn does not
 * round away to "$0.00" and read as free.
 */
export function formatUsageCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
