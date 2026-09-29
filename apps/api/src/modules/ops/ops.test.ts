import { EventEmitter } from 'node:events';
import { daysBetween, dimsHash, istDay, istDayBounds, type Redis } from '@cbi/db';
import { describe, expect, it, vi } from 'vitest';
import { activeUsersPipeline, FUNNEL_STEPS, funnelPipeline, toPaise } from './analytics.service.js';
import {
  createOpsChangeBus,
  createTtlCache,
  flagOn,
  OPS_CONFIG_CHANNEL,
  rolloutBucket,
} from './ops.service.js';

/** An in-memory stand-in for Redis pub/sub shared by several "processes". */
function fakePubSub() {
  const subscribers = new Set<{ channels: Set<string>; emitter: EventEmitter }>();
  const published: string[] = [];
  const client = {
    async publish(channel: string, message: string) {
      published.push(channel);
      for (const s of subscribers)
        if (s.channels.has(channel)) s.emitter.emit('message', channel, message);
      return subscribers.size;
    },
    duplicate() {
      const emitter = new EventEmitter();
      const sub = { channels: new Set<string>(), emitter };
      return {
        connect: async () => undefined,
        async subscribe(channel: string) {
          sub.channels.add(channel);
          subscribers.add(sub);
        },
        on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
        quit: vi.fn(async () => {
          subscribers.delete(sub);
          return 'OK';
        }),
      };
    },
  };
  return { redis: client as unknown as Redis, published, subscribers };
}

describe('feature flag rollout', () => {
  const flag = (enabled: boolean, rolloutPercent: number) => ({
    key: 'reports.publicProof',
    enabled,
    rolloutPercent,
  });

  it('is off when disabled and on for everyone at 100%', () => {
    expect(flagOn(flag(false, 100), 'u1')).toBe(false);
    expect(flagOn(flag(true, 100), null)).toBe(true);
  });

  it('keeps each user in a stable bucket and never includes anonymous visitors', () => {
    const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const on = users.filter((u) => flagOn(flag(true, 30), u)).length;
    expect(on).toBeGreaterThan(230);
    expect(on).toBeLessThan(370);
    expect(rolloutBucket('a.b', 'u1')).toBe(rolloutBucket('a.b', 'u1'));
    expect(flagOn(flag(true, 99), null)).toBe(false);
    expect(flagOn(flag(true, 0), 'u1')).toBe(false);
  });
});

describe('analytics days and money', () => {
  it('uses India-time calendar days', () => {
    expect(istDay(new Date('2026-09-23T18:29:59Z'))).toBe('2026-09-23');
    expect(istDay(new Date('2026-09-23T18:30:00Z'))).toBe('2026-09-24');
    expect(istDayBounds('2026-09-24')).toEqual({
      start: new Date('2026-09-23T18:30:00Z'),
      end: new Date('2026-09-24T18:30:00Z'),
    });
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('hashes dimensions independent of key order', () => {
    expect(dimsHash({})).toBe('');
    expect(dimsHash({ b: '2', a: '1' })).toBe(dimsHash({ a: '1', b: '2' }));
  });

  it('converts USD and INR micros to paise', () => {
    // $1 at ₹84 plus ₹1
    expect(toPaise(1_000_000, 1_000_000, 84)).toBe(8_500);
    expect(toPaise(0, 0, 84)).toBe(0);
  });
});

describe('flag and setting cache invalidation', () => {
  it('reloads after the TTL and immediately after invalidate', async () => {
    let clock = 0;
    let version = 0;
    const load = vi.fn(async () => ++version);
    const cache = createTtlCache(load, 15_000, () => clock);
    expect(await cache.get()).toBe(1);
    clock = 15_000;
    expect(await cache.get()).toBe(1);
    clock = 15_001;
    expect(await cache.get()).toBe(2);
    cache.invalidate();
    expect(await cache.get()).toBe(3);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not keep a load that raced an invalidation', async () => {
    let release!: (v: string) => void;
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue('fresh');
    const cache = createTtlCache(load, 15_000, () => 0);
    const slow = cache.get();
    cache.invalidate(); // an admin change lands while the old rows are in flight
    release('stale');
    expect(await slow).toBe('stale');
    expect(await cache.get()).toBe('fresh');
  });

  it('tells every process to drop its cache when one announces a change', async () => {
    const hub = fakePubSub();
    const api1 = createOpsChangeBus({ redis: hub.redis });
    const api2 = createOpsChangeBus({ redis: hub.redis });
    const dropped = { api1: 0, api2: 0 };
    api1.onChange(() => (dropped.api1 += 1));
    api2.onChange(() => (dropped.api2 += 1));
    const stop1 = await api1.listenForChanges();
    const stop2 = await api2.listenForChanges();

    await api1.announceChange();
    expect(hub.published).toEqual([OPS_CONFIG_CHANNEL]);
    // api1 drops locally and again on its own broadcast; api2 drops on receipt.
    expect(dropped.api1).toBe(2);
    expect(dropped.api2).toBe(1);

    await stop2();
    await api1.announceChange();
    expect(dropped.api2).toBe(1);
    expect(hub.subscribers.size).toBe(1);
    await stop1();
  });

  it('still invalidates locally when publishing fails, and works without Redis', async () => {
    const warn = vi.fn();
    const failing = {
      publish: async () => {
        throw new Error('redis down');
      },
      duplicate: () => {
        throw new Error('unused');
      },
    } as unknown as Redis;
    const bus = createOpsChangeBus({ redis: failing, logger: { warn } as never });
    const onChange = vi.fn();
    bus.onChange(onChange);
    await bus.announceChange();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    const local = createOpsChangeBus({ redis: null });
    const localChange = vi.fn();
    local.onChange(localChange);
    await (
      await local.listenForChanges()
    )();
    await local.announceChange();
    expect(localChange).toHaveBeenCalledTimes(1);
  });
});

describe('dashboard aggregation pipelines', () => {
  const start = new Date('2026-09-23T18:30:00Z');
  const end = new Date('2026-09-24T18:30:00Z');
  const collections = {
    created_interview: 'interviewSessions',
    started_interview: 'interviewSessions',
    completed_interview: 'interviewSessions',
    viewed_report: 'analyticsEvents',
    paid: 'purchases',
  };

  it('builds the funnel as one pipeline over the candidate cohort', () => {
    const pipeline = funnelPipeline(start, end, collections);
    expect(pipeline[0]).toEqual({
      $match: { adminRoles: { $size: 0 }, createdAt: { $gte: start, $lt: end } },
    });
    const lookups = pipeline.flatMap((st) => ('$lookup' in st ? [st.$lookup] : []));
    expect(lookups.map((l) => [l.from, l.localField, l.foreignField])).toEqual([
      ['interviewSessions', '_id', 'userId'],
      ['interviewSessions', '_id', 'userId'],
      ['interviewSessions', '_id', 'userId'],
      ['analyticsEvents', '_id', 'userId'],
      ['purchases', '_id', 'userId'],
    ]);
    // Each step needs only one matching record per user.
    for (const l of lookups) expect(l.pipeline).toContainEqual({ $limit: 1 });
    expect(lookups.map((l) => l.pipeline[0]?.$match)).toEqual([
      {},
      { startedAt: { $ne: null } },
      { state: { $in: ['PROCESSING', 'REPORT_READY'] } },
      { name: 'report_viewed' },
      { 'statusHistory.status': 'PAID' },
    ]);
    const last = pipeline.at(-1)!;
    const group = '$group' in last ? (last.$group as Record<string, unknown>) : {};
    expect(Object.keys(group).filter((k) => k !== '_id')).toEqual([...FUNNEL_STEPS]);
    expect(group.registered).toEqual({ $sum: 1 });
  });

  it('counts active users across events and interviews without returning ids', () => {
    const pipeline = activeUsersPipeline(start, end, 'interviewSessions');
    const within = { $gte: start, $lt: end };
    expect(pipeline[0]).toEqual({ $match: { at: within, userId: { $ne: null } } });
    const union = pipeline.flatMap((st) => ('$unionWith' in st ? [st.$unionWith] : []));
    expect(union.map((u) => u?.coll)).toEqual(['interviewSessions']);
    expect(union[0]?.pipeline[0]).toEqual({
      $match: { $or: [{ createdAt: within }, { startedAt: within }] },
    });
    expect(pipeline.slice(-2)).toEqual([{ $group: { _id: '$userId' } }, { $count: 'users' }]);
  });
});
