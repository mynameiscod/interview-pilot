import { describe, expect, it } from 'vitest';
import { calculateCost, effectivePricing } from './cost.js';
import type { PriceSnapshot, RuntimePrice, UsageUnits } from './types.js';

const usage = (u: Partial<UsageUnits>): UsageUnits => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  requests: 1,
  ...u,
});

const price = (unit: RuntimePrice['unit'], micros: number, from = '2026-01-01'): RuntimePrice => ({
  unit,
  pricePerUnitMicros: micros,
  currency: 'USD',
  effectiveFrom: new Date(from),
});

const snapshot = (...entries: RuntimePrice[]): PriceSnapshot => ({ currency: 'USD', entries });

describe('calculateCost', () => {
  it('prices input and output tokens per million', () => {
    // Claude Opus 5: $5 / $25 per 1M tokens.
    const cost = calculateCost(
      usage({ inputTokens: 12_000, outputTokens: 800 }),
      snapshot(price('PER_1M_INPUT_TOKENS', 5_000_000), price('PER_1M_OUTPUT_TOKENS', 25_000_000)),
    );
    // 12,000 × $5/1M = $0.06 = 60,000 µ; 800 × $25/1M = $0.02 = 20,000 µ.
    expect(cost.costMicros).toBe(80_000);
    expect(cost.currency).toBe('USD');
    expect(cost.lines.map((l) => l.costMicros).sort()).toEqual([20_000, 60_000]);
  });

  it('keeps sub-cent costs that minor units would round to zero', () => {
    const cost = calculateCost(
      usage({ inputTokens: 50, outputTokens: 10 }),
      snapshot(price('PER_1M_INPUT_TOKENS', 150_000), price('PER_1M_OUTPUT_TOKENS', 600_000)),
    );
    // 50 × 0.15 = 7.5 µ → 8; 10 × 0.6 = 6 µ.
    expect(cost.costMicros).toBe(14);
  });

  it('rounds each line half-up to the nearest micro-unit', () => {
    const one = calculateCost(
      usage({ inputTokens: 1 }),
      snapshot(price('PER_1M_INPUT_TOKENS', 500_000)),
    );
    expect(one.costMicros).toBe(1); // 0.5 → 1
    const below = calculateCost(
      usage({ inputTokens: 1 }),
      snapshot(price('PER_1M_INPUT_TOKENS', 499_999)),
    );
    expect(below.costMicros).toBe(0);
  });

  it('bills cached input separately only when a cached price exists', () => {
    const units = usage({ inputTokens: 10_000, cachedInputTokens: 8_000 });
    const withCached = calculateCost(
      units,
      snapshot(
        price('PER_1M_INPUT_TOKENS', 5_000_000),
        price('PER_1M_CACHED_INPUT_TOKENS', 500_000),
      ),
    );
    // 2,000 fresh × $5/1M = 10,000 µ; 8,000 cached × $0.50/1M = 4,000 µ.
    expect(withCached.costMicros).toBe(14_000);
    const withoutCached = calculateCost(units, snapshot(price('PER_1M_INPUT_TOKENS', 5_000_000)));
    expect(withoutCached.costMicros).toBe(50_000);
  });

  it('supports per-minute, per-audio-minute, per-STT-hour, per-character, per-image and per-request pricing', () => {
    const units = usage({
      durationSec: 90,
      audioSec: 30,
      characters: 2_500,
      images: 3,
      requests: 2,
    });
    const cost = (unit: RuntimePrice['unit'], micros: number) =>
      calculateCost(units, snapshot(price(unit, micros))).costMicros;
    expect(cost('PER_MINUTE', 60_000)).toBe(90_000); // 1.5 min × $0.06
    expect(cost('PER_AUDIO_MINUTE', 6_000)).toBe(3_000); // 0.5 min × $0.006
    expect(cost('PER_STT_HOUR', 360_000)).toBe(3_000); // 30 s of $0.36/h
    expect(cost('PER_1M_CHARACTERS', 30_000_000)).toBe(75_000); // 2,500 × $30/1M
    expect(cost('PER_IMAGE', 40_000)).toBe(120_000);
    expect(cost('PER_REQUEST', 1_000)).toBe(2_000);
  });

  it('handles very large volumes exactly (no float overflow)', () => {
    const cost = calculateCost(
      usage({ outputTokens: 9_000_000_000 }),
      snapshot(price('PER_1M_OUTPUT_TOKENS', 75_000_000)),
    );
    expect(cost.costMicros).toBe(675_000_000_000);
  });

  it('costs nothing for zero usage', () => {
    const cost = calculateCost(
      usage({ requests: 0 }),
      snapshot(price('PER_1M_INPUT_TOKENS', 5_000_000), price('PER_REQUEST', 1000)),
    );
    expect(cost.costMicros).toBe(0);
  });
});

describe('effectivePricing', () => {
  const history = [
    price('PER_1M_INPUT_TOKENS', 3_000_000, '2026-01-01'),
    price('PER_1M_INPUT_TOKENS', 5_000_000, '2026-06-01'),
    price('PER_1M_OUTPUT_TOKENS', 15_000_000, '2026-01-01'),
    price('PER_1M_INPUT_TOKENS', 4_000_000, '2027-01-01'),
  ];

  it('picks, per unit, the latest price effective at the call time', () => {
    const snap = effectivePricing(history, new Date('2026-09-23'))!;
    expect(snap.entries.map((e) => [e.unit, e.pricePerUnitMicros])).toEqual([
      ['PER_1M_INPUT_TOKENS', 5_000_000],
      ['PER_1M_OUTPUT_TOKENS', 15_000_000],
    ]);
  });

  it('ignores future prices and applies them once effective', () => {
    expect(effectivePricing(history, new Date('2026-03-01'))!.entries[0]!.pricePerUnitMicros).toBe(
      3_000_000,
    );
    expect(effectivePricing(history, new Date('2027-02-01'))!.entries[0]!.pricePerUnitMicros).toBe(
      4_000_000,
    );
  });

  it('returns null when no price is in force', () => {
    expect(effectivePricing(history, new Date('2025-01-01'))).toBeNull();
    expect(effectivePricing([], new Date())).toBeNull();
  });

  it('never mixes currencies in one snapshot', () => {
    const snap = effectivePricing(
      [
        price('PER_REQUEST', 1, '2026-01-01'),
        { ...price('PER_1M_INPUT_TOKENS', 2, '2026-02-01'), currency: 'INR' },
      ],
      new Date('2026-03-01'),
    )!;
    expect(snap.currency).toBe('INR');
    expect(snap.entries).toHaveLength(1);
  });
});
