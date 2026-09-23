import { describe, expect, it } from 'vitest';
import { writeHeartbeat, type HeartbeatStore } from './heartbeat.js';

describe('writeHeartbeat', () => {
  it('writes a JSON heartbeat that expires after three missed intervals', async () => {
    const calls: unknown[][] = [];
    const store: HeartbeatStore = {
      set: async (...args) => {
        calls.push(args);
        return 'OK';
      },
    };
    await writeHeartbeat(
      store,
      { workerId: 'host:1', version: '1.0.0', at: '2026-09-23T00:00:00.000Z', queues: ['system'] },
      15000,
    );
    expect(calls).toHaveLength(1);
    const [key, value, mode, ttl] = calls[0]!;
    expect(key).toBe('cbi:worker:heartbeat:host:1');
    expect(JSON.parse(value as string)).toMatchObject({ workerId: 'host:1', queues: ['system'] });
    expect(mode).toBe('PX');
    expect(ttl).toBe(45000);
  });
});
