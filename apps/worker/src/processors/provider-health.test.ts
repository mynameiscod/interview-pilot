import { describe, expect, it } from 'vitest';
import { percentile, summarizeWindow } from './provider-health.js';

describe('provider health', () => {
  it('computes nearest-rank percentiles', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('classifies windows by provider error rate', () => {
    expect(summarizeWindow([], 0, 0).status).toBe('IDLE');
    expect(summarizeWindow([100, 300, 200], 20, 1)).toMatchObject({
      status: 'HEALTHY',
      errorRate: 0.05,
      p50LatencyMs: 200,
      p95LatencyMs: 300,
    });
    expect(summarizeWindow([100], 10, 1).status).toBe('DEGRADED');
    expect(summarizeWindow([], 4, 2).status).toBe('DOWN');
  });
});
