import { createLogger } from '@cbi/config';
import { createPlanner } from '@cbi/interview-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applySessionEvent,
  getCreditBalance,
  grantCredits,
  grantFreeCredits,
  InsufficientCreditsError,
  recomputeCreditAccount,
  reserveCredit,
  sessionElapsedMs,
  settleCredit,
} from './index.js';
import { connectMongo, disconnectMongo, mongoose } from './mongo.js';
import { ensureIndexes } from './indexes.js';
import { CreditAccountModel, CreditLedgerModel } from './models/credits.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { InterviewTemplateModel, RoleBlueprintModel, RoleModel } from './models/library.js';
import { ensureLibraryCatalog } from './seed/library.js';

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
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureLibraryCatalog();
});
afterAll(disconnectMongo);

const newId = () => new mongoose.Types.ObjectId();
const at = (s: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, s));

describe('credits', () => {
  it('grants the FREE credit once', async () => {
    const user = newId();
    expect(await grantFreeCredits(user)).toBe(true);
    expect(await grantFreeCredits(user)).toBe(false);
    expect(await getCreditBalance(user)).toMatchObject({ available: 1, reserved: 0 });
    expect(await CreditLedgerModel.countDocuments({ userId: user })).toBe(1);
  });

  it('reserves once per session and refuses without credit', async () => {
    const user = newId();
    const [s1, s2] = [newId(), newId()];
    await grantFreeCredits(user);
    expect((await reserveCredit(user, s1)).created).toBe(true);
    expect((await reserveCredit(user, s1)).created).toBe(false);
    await expect(reserveCredit(user, s2)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await getCreditBalance(user)).toMatchObject({ available: 0, reserved: 1 });
  });

  it('settles exactly once: consume then refund is a no-op', async () => {
    const user = newId();
    const s = newId();
    await grantFreeCredits(user);
    await reserveCredit(user, s);
    expect(await settleCredit(user, s, 'CONSUME')).toEqual({
      type: 'INTERVIEW_CONSUME',
      created: true,
    });
    expect(await settleCredit(user, s, 'REFUND')).toEqual({
      type: 'INTERVIEW_CONSUME',
      created: false,
    });
    expect(await getCreditBalance(user)).toMatchObject({ available: 0, reserved: 0 });
    expect(await settleCredit(user, newId(), 'REFUND')).toBeNull();
  });

  it('refunds into the lot the credit came from', async () => {
    const user = newId();
    const s = newId();
    await grantFreeCredits(user);
    await reserveCredit(user, s);
    await settleCredit(user, s, 'REFUND');
    expect(await getCreditBalance(user)).toMatchObject({ available: 1, reserved: 0 });
  });

  it('draws from the earliest-expiring lot and ignores expired lots', async () => {
    const user = newId();
    const now = new Date();
    const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);
    await grantCredits({
      userId: user,
      amount: 1,
      source: 'PURCHASE',
      idempotencyKey: 'p:late',
      expiresAt: inDays(30),
    });
    await grantCredits({
      userId: user,
      amount: 1,
      source: 'PURCHASE',
      idempotencyKey: 'p:soon',
      expiresAt: inDays(2),
    });
    await grantCredits({
      userId: user,
      amount: 5,
      source: 'PURCHASE',
      idempotencyKey: 'p:old',
      expiresAt: inDays(-1),
    });
    const { lotId } = await reserveCredit(user, newId(), { now });
    const soon = await CreditLedgerModel.findOne({ idempotencyKey: 'p:soon' }).lean();
    expect(String(lotId)).toBe(String(soon!.lotId));
    // FREE (no expiry) + the 30-day lot remain; the expired 5 never count.
    expect((await getCreditBalance(user, now)).available).toBe(2);
  });

  it('lets only one of two concurrent reservations take the last credit', async () => {
    const user = newId();
    await grantFreeCredits(user);
    const results = await Promise.allSettled([
      reserveCredit(user, newId()),
      reserveCredit(user, newId()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InsufficientCreditsError);
    expect(await getCreditBalance(user)).toMatchObject({ available: 0, reserved: 1 });
  });

  it('keeps the projection equal to a rebuild from the ledger', async () => {
    const user = newId();
    await grantFreeCredits(user);
    await grantCredits({ userId: user, amount: 3, source: 'PURCHASE', idempotencyKey: 'p:1' });
    const [a, b, c] = [newId(), newId(), newId()];
    await reserveCredit(user, a);
    await reserveCredit(user, b);
    await reserveCredit(user, c);
    await settleCredit(user, a, 'CONSUME');
    await settleCredit(user, b, 'REFUND');
    const before = await CreditAccountModel.findOne({ userId: user }).lean();
    const rebuilt = await recomputeCreditAccount(user);
    expect({ balance: rebuilt.balance, reserved: rebuilt.reserved }).toEqual({
      balance: before!.balance,
      reserved: before!.reserved,
    });
    expect(rebuilt.lots.map((l) => l.remaining).sort()).toEqual(
      before!.lots.map((l) => l.remaining).sort(),
    );
    expect(rebuilt).toMatchObject({ balance: 2, reserved: 1 });
  });

  it('never lets ledger entries change', async () => {
    const user = newId();
    await grantFreeCredits(user);
    await expect(
      CreditLedgerModel.updateOne({ userId: user }, { $set: { amount: 100 } }),
    ).rejects.toThrow(/append-only/);
    await expect(CreditLedgerModel.deleteMany({ userId: user })).rejects.toThrow(/append-only/);
  });
});

describe('applySessionEvent', () => {
  async function readySession(userId = newId()) {
    const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
    const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
    const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
    const session = await InterviewSessionModel.create({
      userId,
      jobTargetId: newId(),
      templateId: template!._id,
      blueprintId: blueprint!._id,
      state: 'READY',
    });
    return {
      session,
      userId,
      planner: createPlanner(template!.content.rounds, blueprint!.content.competencies),
    };
  }

  async function start(opts: Awaited<ReturnType<typeof readySession>>, now = at(0)) {
    const prepared = await applySessionEvent({
      sessionId: opts.session._id,
      event: { type: 'PREPARE' },
      now,
    });
    expect(prepared).toMatchObject({ ok: true, session: { state: 'READY_TO_START' } });
    return applySessionEvent({
      sessionId: opts.session._id,
      event: { type: 'START' },
      set: { planner: opts.planner },
      now,
    });
  }

  it('starts: reserves a credit, runs the clock and opens the first round', async () => {
    const ctx = await readySession();
    await grantFreeCredits(ctx.userId);
    const result = await start(ctx);
    if (!result.ok) throw new Error(result.reason);
    const s = result.session;
    expect(s).toMatchObject({ state: 'ACTIVE', live: true, credit: { status: 'RESERVED' } });
    expect(s.startedAt).toEqual(at(0));
    expect(s.clock).toMatchObject({ budgetMs: 1_920_000, activeMs: 0, runningSince: at(0) });
    expect(s.planner!.roundIdx).toBe(0);
    expect(s.planner!.rounds[0]!.state).toBe('ACTIVE');
    expect(await getCreditBalance(ctx.userId)).toMatchObject({ available: 0, reserved: 1 });
  });

  it('rolls everything back when there is no credit', async () => {
    const ctx = await readySession();
    // No credit was granted to this user.
    await expect(start(ctx)).rejects.toBeInstanceOf(InsufficientCreditsError);
    const s = await InterviewSessionModel.findById(ctx.session._id).lean();
    expect(s).toMatchObject({ state: 'READY_TO_START', live: false, credit: { status: 'NONE' } });
    expect(s!.clock).toBeNull();
  });

  it('allows only one live interview per candidate', async () => {
    const first = await readySession();
    const second = await readySession(first.userId);
    await grantFreeCredits(first.userId);
    await grantCredits({
      userId: first.userId,
      amount: 1,
      source: 'PURCHASE',
      idempotencyKey: 'p:2',
    });
    await start(first);
    await expect(start(second)).rejects.toThrow(/E11000|duplicate key/);
    expect(await getCreditBalance(first.userId)).toMatchObject({ available: 1, reserved: 1 });
  });

  it('does not count disconnected or paused time, then refunds an unused expired interview', async () => {
    const ctx = await readySession();
    await grantFreeCredits(ctx.userId);
    await start(ctx, at(0));
    const id = ctx.session._id;
    let r = await applySessionEvent({
      sessionId: id,
      event: { type: 'DISCONNECTED' },
      now: at(30),
    });
    expect(r).toMatchObject({
      ok: true,
      session: { state: 'RECONNECTING', resumeTo: 'ACTIVE', disconnectedAt: at(30) },
    });
    r = await applySessionEvent({ sessionId: id, event: { type: 'RECONNECTED' }, now: at(50) });
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({ state: 'ACTIVE', resumeTo: null, disconnectedAt: null });
    expect(sessionElapsedMs(r.session, at(60))).toBe(40_000);

    await applySessionEvent({ sessionId: id, event: { type: 'DISCONNECTED' }, now: at(60) });
    r = await applySessionEvent({ sessionId: id, event: { type: 'GRACE_EXPIRED' }, now: at(59) });
    expect(r).toMatchObject({ ok: true, session: { state: 'PAUSED', live: true } });
    r = await applySessionEvent({
      sessionId: id,
      event: { type: 'RESUME_WINDOW_EXPIRED' },
      now: at(59),
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.session).toMatchObject({
      state: 'EXPIRED',
      live: false,
      credit: { status: 'REFUNDED' },
    });
    expect(r.session.clock!.activeMs).toBe(40_000);
    expect(await getCreditBalance(ctx.userId)).toMatchObject({ available: 1, reserved: 0 });
    // Not meaningful: it cannot move on to evaluation.
    expect(await applySessionEvent({ sessionId: id, event: { type: 'PROCESS' } })).toEqual({
      ok: false,
      reason: 'GUARD_FAILED',
    });
  });

  it('consumes the credit when a meaningful interview finishes', async () => {
    const ctx = await readySession();
    await grantFreeCredits(ctx.userId);
    const started = await start(ctx);
    if (!started.ok) throw new Error(started.reason);
    await InterviewSessionModel.updateOne(
      { _id: ctx.session._id },
      { $set: { 'planner.answeredCount': 3 } },
    );
    let r = await applySessionEvent({
      sessionId: ctx.session._id,
      event: { type: 'END_REQUESTED' },
      now: at(120),
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.planner!.rounds.map((x) => x.state)).toEqual([
      'COMPLETED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
    ]);
    expect(r.session).toMatchObject({
      state: 'COMPLETING',
      live: true,
      endedAt: at(120),
      endReason: 'END_REQUESTED',
    });
    expect(r.session.clock!.runningSince).toBeNull();
    r = await applySessionEvent({
      sessionId: ctx.session._id,
      event: { type: 'FINALIZE' },
      now: at(121),
    });
    expect(r).toMatchObject({
      ok: true,
      session: { state: 'PROCESSING', live: false, credit: { status: 'CONSUMED' } },
      effects: [{ type: 'ENQUEUE_EVALUATION' }],
    });
    expect(await getCreditBalance(ctx.userId)).toMatchObject({ available: 0, reserved: 0 });
  });

  it('refunds on failure and rejects stale or invalid events', async () => {
    const ctx = await readySession();
    await grantFreeCredits(ctx.userId);
    const started = await start(ctx);
    if (!started.ok) throw new Error(started.reason);
    expect(
      await applySessionEvent({
        sessionId: ctx.session._id,
        event: { type: 'FAIL' },
        expectedVersion: 0,
      }),
    ).toEqual({ ok: false, reason: 'CONFLICT' });
    expect(
      await applySessionEvent({ sessionId: ctx.session._id, event: { type: 'START' } }),
    ).toEqual({
      ok: false,
      reason: 'INVALID_EVENT',
    });
    expect(
      await applySessionEvent({
        sessionId: ctx.session._id,
        event: { type: 'FAIL' },
        userId: newId(),
      }),
    ).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const failed = await applySessionEvent({ sessionId: ctx.session._id, event: { type: 'FAIL' } });
    expect(failed).toMatchObject({
      ok: true,
      session: { state: 'FAILED', live: false, credit: { status: 'REFUNDED' } },
    });
    expect(await getCreditBalance(ctx.userId)).toMatchObject({ available: 1, reserved: 0 });
  });
});
