import type { Logger } from '@cbi/config';
import { Redis, type RedisOptions } from 'ioredis';

export type RedisPurpose =
  /** Normal commands: fail fast so request handlers do not hang when Redis is down. */
  | 'command'
  /** BullMQ connections: BullMQ requires unlimited retries and manages blocking calls itself. */
  | 'queue';

/**
 * Optional Redis Sentinel discovery (the `redis-ha` compose profile). With
 * sentinels set, the client asks them for the current master of `name` and
 * follows failovers; REDIS_URL then only supplies the password and database.
 */
export interface RedisSentinelSettings {
  /** Comma-separated host:port list, e.g. `redis-sentinel-1:26379,redis-sentinel-2:26379`. */
  sentinels?: string;
  /** Master group name configured in the sentinels. */
  name?: string;
}

/** Parses `host:port,host:port` (port defaults to 26379). */
export function parseSentinels(list: string): { host: string; port: number }[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(':');
      const parsed = port ? Number(port) : 26379;
      if (!host || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`invalid sentinel address: ${entry}`);
      }
      return { host, port: parsed };
    });
}

/** Connection options for a sentinel-managed master, or null for a plain REDIS_URL connection. */
export function sentinelOptions(
  url: string,
  sentinel: RedisSentinelSettings | undefined,
): RedisOptions | null {
  if (!sentinel?.sentinels) return null;
  const parsed = new URL(url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const db = Number(parsed.pathname.replace(/^\//, '') || 0);
  return {
    sentinels: parseSentinels(sentinel.sentinels),
    name: sentinel.name ?? 'cbi',
    // The sentinels in docker-compose.production.yml require the same password.
    password,
    sentinelPassword: password,
    db: Number.isInteger(db) ? db : 0,
    ...(parsed.protocol === 'rediss:' ? { tls: {}, enableTLSForSentinelMode: true } : {}),
  };
}

export function createRedis(
  url: string,
  logger: Logger,
  purpose: RedisPurpose = 'command',
  sentinel?: RedisSentinelSettings,
): Redis {
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: purpose === 'queue' ? null : 3,
    enableOfflineQueue: purpose === 'queue',
  };
  const viaSentinel = sentinelOptions(url, sentinel);
  const client = viaSentinel ? new Redis({ ...viaSentinel, ...options }) : new Redis(url, options);
  // Log the error class only: messages and the URL may contain credentials.
  client.on('error', (err: Error) => logger.warn({ errName: err.name, purpose }, 'redis error'));
  client.on('ready', () => logger.info({ purpose }, 'redis ready'));
  return client;
}

export async function pingRedis(client: Redis): Promise<void> {
  const reply = await client.ping();
  if (reply !== 'PONG') throw new Error('unexpected ping reply');
}

export type { Redis };
