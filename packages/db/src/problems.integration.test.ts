import { createLogger } from '@cbi/config';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIndexes } from './indexes.js';
import { ProblemModel } from './models/coding.js';
import { connectMongo, disconnectMongo } from './mongo.js';
import { ensureProblemBank, SEED_PROBLEMS } from './seed/problems.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

beforeAll(async () => {
  await connectMongo({
    uri: MONGODB_URI,
    autoIndex: false,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  await ensureIndexes();
});
afterAll(disconnectMongo);
beforeEach(async () => {
  await ProblemModel.deleteMany({});
});

const seed = (key: string) => SEED_PROBLEMS.find((p) => p.key === key)!;
const versions = (key: string) => ProblemModel.find({ key }).sort({ version: 1 }).lean();

describe('problem bank seed', () => {
  it('creates every problem once, active, and does nothing the second time', async () => {
    expect(await ensureProblemBank()).toBe(SEED_PROBLEMS.length);
    expect(await ProblemModel.countDocuments({ active: true })).toBe(SEED_PROBLEMS.length);
    expect(await ensureProblemBank()).toBe(0);
    const sql = await ProblemModel.findOne({ key: 'customers-without-orders' }).lean();
    expect(sql!.content.languages).toEqual(['sql']);
    expect(sql!.seedRevision).toBe(1);
  });

  it('adds a newer seed revision as the next active version of a seeded key', async () => {
    // What installs seeded before revisions existed have: version 1, created by nobody.
    const old = seed('balanced-brackets');
    await ProblemModel.create({
      key: old.key,
      version: 1,
      active: true,
      content: { ...old.content, hiddenTests: old.content.hiddenTests.slice(0, 5) },
      reason: 'Seeded default',
    });
    await ensureProblemBank();
    const list = await versions(old.key);
    expect(list.map((v) => [v.version, v.active, v.seedRevision])).toEqual([
      [1, false, null],
      [2, true, old.revision],
    ]);
    expect(list[1]!.content.hiddenTests.length).toBeGreaterThanOrEqual(8);
    expect(await ensureProblemBank()).toBe(0);
  });

  it('never touches a key an admin has versioned, and keeps a deactivated key inactive', async () => {
    const owned = seed('merge-intervals');
    await ProblemModel.create({
      key: owned.key,
      version: 1,
      active: true,
      content: owned.content,
      reason: 'Seeded default',
    });
    await ProblemModel.create({
      key: owned.key,
      version: 2,
      active: false,
      content: owned.content,
      createdBy: new Types.ObjectId(),
      reason: 'Admin edit',
    });
    const retired = seed('top-k-words');
    await ProblemModel.create({
      key: retired.key,
      version: 1,
      active: false,
      content: retired.content,
      reason: 'Seeded default',
    });
    await ensureProblemBank();
    expect(await ProblemModel.countDocuments({ key: owned.key })).toBe(2);
    const topK = await versions(retired.key);
    expect(topK.map((v) => [v.version, v.active])).toEqual([
      [1, false],
      [2, false],
    ]);
  });
});
