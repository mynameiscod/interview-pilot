import { createLogger } from '@cbi/config';
import {
  AuditLogModel,
  AuthIdentityModel,
  connectMongo,
  CreditLedgerModel,
  disconnectMongo,
  ensureIndexes,
  InterviewReportModel,
  JobTargetModel,
  mongoose,
  PurchaseModel,
  RefreshTokenModel,
  ResumeModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAccountErasure } from './account-erasure.js';

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
});
afterAll(disconnectMongo);

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put: async (key: string, body: Buffer) => void objects.set(key, body),
    delete: async (key: string) => void objects.delete(key),
  };
}

const DAY = 24 * 3600 * 1000;

async function pendingCandidate(scheduledFor: Date) {
  const user = await UserModel.create({
    primaryEmail: 'asha@example.com',
    emailVerifiedAt: new Date(),
    status: 'DELETION_PENDING',
    deletion: { requestedAt: new Date(), scheduledFor, method: 'TYPED' },
  });
  await UserProfileModel.create({ userId: user._id, displayName: 'Asha' });
  await AuthIdentityModel.create({
    userId: user._id,
    provider: 'EMAIL',
    subject: 'asha@example.com',
    verifiedAt: new Date(),
  });
  return user;
}

describe('account erasure', () => {
  it('erases a due account, keeps pseudonymised tax records and audits it', async () => {
    const storage = memoryStorage();
    const user = await pendingCandidate(new Date(Date.now() - DAY));
    storage.objects.set('resumes/u/1.pdf', Buffer.from('cv'));
    await ResumeModel.create({
      userId: user._id,
      storageKey: 'resumes/u/1.pdf',
      originalName: 'cv.pdf',
      mime: 'application/pdf',
      size: 2,
      sha256: 'x',
    });
    await JobTargetModel.create({ userId: user._id, source: 'ROLE_ONLY', roleTitle: 'QA' });
    await InterviewReportModel.collection.insertOne({
      userId: user._id,
      sessionId: new mongoose.Types.ObjectId(),
      revision: 1,
      pdf: { status: 'READY', storageKey: 'reports/s/1.pdf', generatedAt: new Date() },
    });
    storage.objects.set('reports/s/1.pdf', Buffer.from('pdf'));
    await RefreshTokenModel.create({
      userId: user._id,
      familyId: 'f',
      tokenHash: 'h',
      audience: 'candidate',
      expiresAt: new Date(Date.now() + DAY),
    });
    await PurchaseModel.collection.insertOne({ userId: user._id, status: 'PAID' });
    await CreditLedgerModel.collection.insertOne({ userId: user._id, type: 'GRANT', amount: 1 });

    const counts = await runAccountErasure({ storage, logger });
    expect(counts).toEqual({ erased: 1, errors: 0 });
    expect(storage.objects.size).toBe(0);
    for (const model of [
      ResumeModel,
      JobTargetModel,
      RefreshTokenModel,
      AuthIdentityModel,
      UserProfileModel,
    ] as const) {
      expect(await (model as typeof ResumeModel).countDocuments({ userId: user._id })).toBe(0);
    }
    expect(await InterviewReportModel.countDocuments({ userId: user._id })).toBe(0);
    const tombstone = await UserModel.findById(user._id).lean();
    expect(tombstone!.status).toBe('DELETED');
    expect(tombstone!.primaryEmail).toBeUndefined();
    expect(await PurchaseModel.countDocuments({ userId: user._id })).toBe(1);
    expect(await CreditLedgerModel.countDocuments({ userId: user._id })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'privacy.account_erased' })).toBe(1);
  });

  it('leaves accounts still inside their grace period alone', async () => {
    const user = await pendingCandidate(new Date(Date.now() + DAY));
    await runAccountErasure({ storage: memoryStorage(), logger });
    expect((await UserModel.findById(user._id).lean())!.status).toBe('DELETION_PENDING');
  });
});
