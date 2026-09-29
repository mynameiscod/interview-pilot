import { describe, expect, it } from 'vitest';
import { parseSentinels, sentinelOptions } from './redis.js';

describe('parseSentinels', () => {
  it('parses host:port pairs and defaults the port', () => {
    expect(parseSentinels('redis-sentinel-1:26379, redis-sentinel-2')).toEqual([
      { host: 'redis-sentinel-1', port: 26379 },
      { host: 'redis-sentinel-2', port: 26379 },
    ]);
  });

  it('rejects malformed entries', () => {
    expect(() => parseSentinels('redis-sentinel-1:notaport')).toThrow(/invalid sentinel/);
  });
});

describe('sentinelOptions', () => {
  it('is null without sentinels (plain REDIS_URL connection)', () => {
    expect(sentinelOptions('redis://:pw@redis:6379', undefined)).toBeNull();
    expect(sentinelOptions('redis://:pw@redis:6379', { sentinels: '' })).toBeNull();
  });

  it('takes the password and database from REDIS_URL', () => {
    expect(
      sentinelOptions('redis://:p%40ss@redis:6379/2', {
        sentinels: 'redis-sentinel-1:26379',
        name: 'cbi',
      }),
    ).toEqual({
      sentinels: [{ host: 'redis-sentinel-1', port: 26379 }],
      name: 'cbi',
      password: 'p@ss',
      sentinelPassword: 'p@ss',
      db: 2,
    });
  });
});
