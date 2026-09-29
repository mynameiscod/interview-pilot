import { describe, expect, it, vi } from 'vitest';
import { withUsageObserver, type AiUsageRecord, type UsageSink } from './types.js';

const record = {
  feature: 'turn.next',
  providerKey: 'openai',
  outcome: 'TIMEOUT',
  latencyMs: 30_000,
} as unknown as AiUsageRecord;

describe('withUsageObserver', () => {
  it('shows every record to the observer, then writes it', async () => {
    const order: string[] = [];
    const sink: UsageSink = { record: vi.fn(async () => void order.push('write')) };
    const observed = withUsageObserver(sink, (r) => order.push(`observe:${r.outcome}`));
    await observed.record(record);
    expect(order).toEqual(['observe:TIMEOUT', 'write']);
    expect(sink.record).toHaveBeenCalledWith(record);
  });

  it('still writes when the observer throws', async () => {
    const sink: UsageSink = { record: vi.fn(async () => undefined) };
    const observed = withUsageObserver(sink, () => {
      throw new Error('metrics broken');
    });
    await expect(observed.record(record)).resolves.toBeUndefined();
    expect(sink.record).toHaveBeenCalledOnce();
  });
});
