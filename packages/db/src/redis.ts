import type { Logger } from '@cbi/config';
import { Redis } from 'ioredis';

export type RedisPurpose =
  /** Normal commands: fail fast so request handlers do not hang when Redis is down. */
  | 'command'
  /** BullMQ connections: BullMQ requires unlimited retries and manages blocking calls itself. */
  | 'queue';

export function createRedis(url: string, logger: Logger, purpose: RedisPurpose = 'command'): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: purpose === 'queue' ? null : 3,
    enableOfflineQueue: purpose === 'queue',
  });
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
