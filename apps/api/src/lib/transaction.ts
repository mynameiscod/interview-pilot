import { mongoose } from '@cbi/db';
import type { ClientSession } from 'mongoose';

/** Runs `fn` in a MongoDB transaction (retried by the driver on transient errors). */
export async function transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
