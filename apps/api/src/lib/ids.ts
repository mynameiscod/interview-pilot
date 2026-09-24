import { mongoose } from '@cbi/db';
import { AppError } from './errors.js';

/** Parses a route id; malformed ids read as "not found" so they reveal nothing. */
export function objectId(id: unknown, what: string) {
  const value = String(id);
  if (!mongoose.isValidObjectId(value) || !/^[0-9a-f]{24}$/i.test(value)) {
    throw AppError.notFound(`${what} not found`);
  }
  return new mongoose.Types.ObjectId(value);
}

export const iso = (d: Date) => new Date(d).toISOString();
