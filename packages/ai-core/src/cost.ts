import type { Currency, PricingUnit } from '@cbi/shared-types';
import type { PriceSnapshot, RuntimePrice, UsageUnits } from './types.js';

/**
 * How each pricing unit maps onto usage: `quantity` in the unit's base
 * measure, and `divisor` = base measures per priced unit. Cost for one line
 * = quantity × pricePerUnitMicros ÷ divisor.
 */
const UNIT_RULES: Readonly<
  Record<
    PricingUnit,
    { quantity: (u: UsageUnits, hasCachedPrice: boolean) => number; divisor: number }
  >
> = {
  // Cached input tokens are billed separately only when the model has a cached-input price.
  PER_1M_INPUT_TOKENS: {
    quantity: (u, hasCachedPrice) =>
      hasCachedPrice ? Math.max(0, u.inputTokens - u.cachedInputTokens) : u.inputTokens,
    divisor: 1_000_000,
  },
  PER_1M_CACHED_INPUT_TOKENS: { quantity: (u) => u.cachedInputTokens, divisor: 1_000_000 },
  PER_1M_OUTPUT_TOKENS: { quantity: (u) => u.outputTokens, divisor: 1_000_000 },
  // Durations are measured in milliseconds so fractional seconds are not lost.
  PER_MINUTE: { quantity: (u) => Math.round((u.durationSec ?? 0) * 1000), divisor: 60_000 },
  PER_AUDIO_MINUTE: { quantity: (u) => Math.round((u.audioSec ?? 0) * 1000), divisor: 60_000 },
  PER_STT_HOUR: { quantity: (u) => Math.round((u.audioSec ?? 0) * 1000), divisor: 3_600_000 },
  PER_1M_CHARACTERS: { quantity: (u) => u.characters ?? 0, divisor: 1_000_000 },
  PER_IMAGE: { quantity: (u) => u.images ?? 0, divisor: 1 },
  PER_REQUEST: { quantity: (u) => u.requests, divisor: 1 },
};

/** Integer division rounding half away from zero (all inputs are non-negative). */
function divRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

export interface CostLine {
  unit: PricingUnit;
  quantity: number;
  pricePerUnitMicros: number;
  costMicros: number;
}

export interface CostBreakdown {
  costMicros: number;
  currency: Currency;
  lines: CostLine[];
}

/**
 * Pure cost calculator: `(units, priceSnapshot) → cost`. Arithmetic is exact
 * integer (BigInt) math; each line is rounded half-up to the nearest
 * micro-unit and lines are summed. Units without a price cost nothing.
 */
export function calculateCost(units: UsageUnits, snapshot: PriceSnapshot): CostBreakdown {
  const hasCachedPrice = snapshot.entries.some((e) => e.unit === 'PER_1M_CACHED_INPUT_TOKENS');
  const lines: CostLine[] = snapshot.entries.map((entry) => {
    const rule = UNIT_RULES[entry.unit];
    const quantity = Math.max(0, Math.trunc(rule.quantity(units, hasCachedPrice)));
    const costMicros = Number(
      divRoundHalfUp(BigInt(quantity) * BigInt(entry.pricePerUnitMicros), BigInt(rule.divisor)),
    );
    return { unit: entry.unit, quantity, pricePerUnitMicros: entry.pricePerUnitMicros, costMicros };
  });
  return {
    costMicros: lines.reduce((sum, line) => sum + line.costMicros, 0),
    currency: snapshot.currency,
    lines,
  };
}

/**
 * The price list in force at `at`: for each unit, the entry with the latest
 * `effectiveFrom` that is not after `at`. Returns null when nothing applies.
 * A model's prices share one currency (enforced when prices are added); if
 * mixed data slips in, the currency of the most recent entry wins and other
 * currencies are dropped rather than summed.
 */
export function effectivePricing(pricing: readonly RuntimePrice[], at: Date): PriceSnapshot | null {
  const current = new Map<PricingUnit, RuntimePrice>();
  for (const entry of pricing) {
    if (entry.effectiveFrom.getTime() > at.getTime()) continue;
    const existing = current.get(entry.unit);
    if (!existing || entry.effectiveFrom.getTime() > existing.effectiveFrom.getTime()) {
      current.set(entry.unit, entry);
    }
  }
  if (current.size === 0) return null;
  const entries = [...current.values()].sort(
    (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime(),
  );
  const currency = entries[0]!.currency;
  return {
    currency,
    entries: entries
      .filter((e) => e.currency === currency)
      .sort((a, b) => a.unit.localeCompare(b.unit)),
  };
}
