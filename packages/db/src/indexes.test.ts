import { describe, expect, it } from 'vitest';
import { planTtlIndex, supersededActiveExports } from './indexes.js';

const KEY = { at: -1 };
const id = { name: '_id_', key: { _id: 1 } };

describe('TTL index plan', () => {
  it('creates the index when it is missing', () => {
    expect(planTtlIndex([id], KEY, 100)).toEqual({ op: 'create' });
    // Same field, other direction or compound: not the same index.
    expect(planTtlIndex([id, { name: 'at_1', key: { at: 1 } }], KEY, 100)).toEqual({
      op: 'create',
    });
    expect(planTtlIndex([{ name: 'at_-1_x_1', key: { at: -1, x: 1 } }], KEY, 100)).toEqual({
      op: 'create',
    });
  });

  it('changes the expiry in place when it differs, or adds it to a plain index', () => {
    expect(
      planTtlIndex([id, { name: 'at_-1', key: KEY, expireAfterSeconds: 50 }], KEY, 100),
    ).toEqual({ op: 'collMod', name: 'at_-1', from: 50 });
    expect(planTtlIndex([{ name: 'at_-1', key: KEY }], KEY, 100)).toEqual({
      op: 'collMod',
      name: 'at_-1',
      from: null,
    });
  });

  it('does nothing when the expiry already matches', () => {
    expect(planTtlIndex([{ name: 'at_-1', key: KEY, expireAfterSeconds: 100 }], KEY, 100)).toEqual({
      op: 'none',
    });
  });
});

describe('superseded active exports', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));

  it('keeps the newest active export of each campaign', () => {
    const a1 = { _id: 'a1', campaignId: 'A', createdAt: at(1) };
    const a2 = { _id: 'a2', campaignId: 'A', createdAt: at(3) };
    const a3 = { _id: 'a3', campaignId: 'A', createdAt: at(2) };
    const b1 = { _id: 'b1', campaignId: 'B', createdAt: at(0) };
    expect(supersededActiveExports([a1, a2, a3, b1])).toEqual([a1, a3]);
  });

  it('finds nothing when each campaign has one', () => {
    expect(supersededActiveExports([{ _id: 'x', campaignId: 'A', createdAt: at(0) }])).toEqual([]);
    expect(supersededActiveExports([])).toEqual([]);
  });
});
