import type { Logger } from '@cbi/config';
import mongoose from 'mongoose';

export interface MongoOptions {
  uri: string;
  autoIndex: boolean;
  logger: Logger;
}

/**
 * Connects Mongoose. The URI must point at a replica set (single-node in dev
 * and initial production) because credit and payment flows use transactions.
 */
export async function connectMongo(opts: MongoOptions): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => opts.logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => opts.logger.info('mongo reconnected'));
  const conn = await mongoose.connect(opts.uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
    autoIndex: opts.autoIndex,
  });
  opts.logger.info({ db: conn.connection.name }, 'mongo connected');
  return conn;
}

export async function pingMongo(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    throw new Error('mongo not connected');
  }
  await db.admin().command({ ping: 1 });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
