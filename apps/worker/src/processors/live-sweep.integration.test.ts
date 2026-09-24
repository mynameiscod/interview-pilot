import { createLogger } from '@cbi/config';
import {
  applySessionEvent,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  ensureLibraryCatalog,
  getCreditBalance,
  grantFreeCredits,
  InterviewSessionModel,
  InterviewTemplateModel,
  mongoose,
  RoleBlueprintModel,
  RoleModel,
} from '@cbi/db';
import { createPlanner } from '@cbi/interview-engine';
import { LIVE_POLICY } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepLiveSessions } from './live-sweep.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureLibraryCatalog();
});
afterAll(disconnectMongo);

const T0 = new Date('2026-09-24T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

/** A started (ACTIVE) interview at T0 for a fresh candidate. */
async function activeInterview(answered = 0) {
  const userId = new mongoose.Types.ObjectId();
  const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const role = await RoleModel.findOne({ slug: 'qa-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const s = await InterviewSessionModel.create({
    userId,
    jobTargetId: new mongoose.Types.ObjectId(),
    templateId: template!._id,
    blueprintId: blueprint!._id,
    state: 'READY_TO_START',
  });
  await grantFreeCredits(userId);
  const planner = {
    ...createPlanner(template!.content.rounds, blueprint!.content.competencies),
    answeredCount: answered,
  };
  const r = await applySessionEvent({
    sessionId: s._id,
    event: { type: 'START' },
    set: { planner },
    now: T0,
  });
  if (!r.ok) throw new Error(r.reason);
  await InterviewSessionModel.updateOne({ _id: s._id }, { $set: { lastSeenAt: T0 } });
  return { id: s._id, userId };
}

const state = async (id: mongoose.Types.ObjectId) =>
  (await InterviewSessionModel.findById(id).lean())!;

describe('sweepLiveSessions', () => {
  it('walks a silent interview through disconnect, pause and expiry, refunding unused credit', async () => {
    const { id, userId } = await activeInterview();

    // Heartbeats still fresh: nothing happens.
    expect(await sweepLiveSessions({ logger, now: plus(10_000) })).toEqual({
      disconnected: 0,
      paused: 0,
      expired: 0,
      finalized: 0,
    });

    let now = plus(LIVE_POLICY.heartbeatTimeoutMs + 1);
    expect((await sweepLiveSessions({ logger, now })).disconnected).toBe(1);
    expect(await state(id)).toMatchObject({ state: 'RECONNECTING', live: true });
    expect((await state(id)).clock!.activeMs).toBe(LIVE_POLICY.heartbeatTimeoutMs + 1);

    now = new Date(now.getTime() + LIVE_POLICY.reconnectGraceMs + 1);
    expect((await sweepLiveSessions({ logger, now })).paused).toBe(1);
    expect((await state(id)).state).toBe('PAUSED');

    now = new Date(now.getTime() + LIVE_POLICY.resumeWindowMs + 1);
    expect((await sweepLiveSessions({ logger, now })).expired).toBe(1);
    expect(await state(id)).toMatchObject({
      state: 'EXPIRED',
      live: false,
      credit: { status: 'REFUNDED' },
    });
    expect(await getCreditBalance(userId)).toMatchObject({ available: 1, reserved: 0 });

    // Running again changes nothing.
    expect(await sweepLiveSessions({ logger, now })).toEqual({
      disconnected: 0,
      paused: 0,
      expired: 0,
      finalized: 0,
    });
  });

  it('sends a meaningful expired interview on to evaluation and consumes its credit', async () => {
    const { id, userId } = await activeInterview(3);
    await applySessionEvent({ sessionId: id, event: { type: 'DISCONNECTED' }, now: plus(1000) });
    await applySessionEvent({ sessionId: id, event: { type: 'GRACE_EXPIRED' }, now: plus(2000) });
    await InterviewSessionModel.updateOne({ _id: id }, { $set: { pausedAt: plus(2000) } });
    await sweepLiveSessions({ logger, now: plus(2000 + LIVE_POLICY.resumeWindowMs + 1) });
    expect(await state(id)).toMatchObject({ state: 'PROCESSING', credit: { status: 'CONSUMED' } });
    expect(await getCreditBalance(userId)).toMatchObject({ available: 0, reserved: 0 });
  });

  it('finishes an interview left in COMPLETING by a crashed API instance', async () => {
    const { id } = await activeInterview();
    await applySessionEvent({ sessionId: id, event: { type: 'END_REQUESTED' }, now: plus(1000) });
    // Recently changed: another instance may still be finishing it.
    expect((await sweepLiveSessions({ logger, now: new Date() })).finalized).toBe(0);
    await InterviewSessionModel.collection.updateOne(
      { _id: id },
      { $set: { updatedAt: plus(1000) } },
    );
    expect((await sweepLiveSessions({ logger, now: plus(1000 + 3 * 60_000) })).finalized).toBe(1);
    expect(await state(id)).toMatchObject({ state: 'PROCESSING', credit: { status: 'REFUNDED' } });
  });
});
