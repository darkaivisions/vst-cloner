import type { LanguageModelUsage } from "ai";
import type { CatalogCost } from "./catalog.ts";

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** USD; undefined if the price of at least one call is unknown. */
  cost: number | undefined;
}

/** Accumulates token usage and cost across calls of one job. */
export class UsageMeter {
  private totals: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };

  add(usage: LanguageModelUsage, price: CatalogCost | undefined): void {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

    this.totals.calls += 1;
    this.totals.inputTokens += input;
    this.totals.outputTokens += output;
    this.totals.cachedInputTokens += cacheRead;

    if (this.totals.cost === undefined || price?.input === undefined || price.output === undefined) {
      this.totals.cost = undefined;
      return;
    }
    const uncached = Math.max(0, input - cacheRead - cacheWrite);
    this.totals.cost +=
      (uncached * price.input +
        cacheRead * (price.cache_read ?? price.input) +
        cacheWrite * (price.cache_write ?? price.input) +
        output * price.output) /
      1e6;
  }

  get(): UsageTotals {
    return { ...this.totals };
  }
}

export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "unknown cost";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(3)}`;
}

export function formatUsage(totals: UsageTotals): string {
  const cached = totals.cachedInputTokens > 0 ? ` (${totals.cachedInputTokens} cached)` : "";
  return `${totals.inputTokens} in${cached} / ${totals.outputTokens} out tokens, ${formatCost(totals.cost)}`;
}
