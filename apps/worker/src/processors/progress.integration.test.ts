import { emailLinkKey, verifyEmailLink } from '@cbi/auth-core';
import { createLogger } from '@cbi/config';
import {
  CertificateModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  InterviewSessionModel,
  mongoose,
  UserModel,
  UserProfileModel,
  UserProgressModel,
} from '@cbi/db';
import { createRecordingEmailProvider } from '@cbi/provider-adapters/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processCertificatePdf } from './certificate.js';
import { NUDGE_INTERVAL_MS, runPracticeNudges } from './practice-nudge.js';

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
const linkKey = emailLinkKey('worker-test-secret');

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

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-09-29T06:00:00Z'); // 11:30 in India

/** A candidate who finished a session on each of the given days ago. */
async function candidate(
  opts: {
    optIn?: boolean;
    verified?: boolean;
    language?: 'en' | 'hi' | 'te';
    daysAgo?: number[];
  } = {},
) {
  const user = await UserModel.create({
    primaryEmail: `c${Math.random().toString(36).slice(2, 8)}@example.com`,
    emailVerifiedAt: opts.verified === false ? undefined : new Date(),
  });
  await UserProfileModel.create({
    userId: user._id,
    displayName: 'Asha',
    preferredInterviewLanguage: opts.language ?? 'en',
    productUpdatesOptIn: opts.optIn ?? true,
  });
  for (const d of opts.daysAgo ?? []) {
    await InterviewSessionModel.create({
      userId: user._id,
      kind: 'DRILL',
      jobTargetId: new mongoose.Types.ObjectId(),
      templateId: new mongoose.Types.ObjectId(),
      state: 'REPORT_READY',
      endedAt: new Date(now.getTime() - d * DAY),
    });
  }
  return user;
}

describe('practice nudges', () => {
  it('emails opted-in candidates once per interval, localized, with a signed unsubscribe link', async () => {
    const mail = createRecordingEmailProvider();
    const atRisk = await candidate({ daysAgo: [1, 2], language: 'hi' });
    const away = await candidate({ daysAgo: [5] });
    await candidate({ daysAgo: [0, 1] }); // practised today
    await candidate({ daysAgo: [1, 2], optIn: false });
    await candidate({ daysAgo: [5], verified: false });
    await candidate(); // never practised

    const deps = { email: mail.provider, candidateUrl: 'https://i.test/', linkKey, logger };
    const counts = await runPracticeNudges({ ...deps, now });
    expect(counts).toMatchObject({ sent: 2, failed: 0 });
    const toRisk = mail.sent.find((m) => m.to === atRisk.primaryEmail)!;
    expect(toRisk.subject).toMatch(/[ऀ-ॿ]/u);
    expect(toRisk.text).toContain('https://i.test/app');
    const token = decodeURIComponent(/unsubscribe\?token=([^\s]+)/.exec(toRisk.text)![1]!);
    expect(verifyEmailLink(linkKey, token, 'unsubscribe', now)?.userId).toBe(String(atRisk._id));
    expect(mail.sent.find((m) => m.to === away.primaryEmail)?.subject).toBe(
      'A quick drill to get back into practice',
    );

    // Two days later: still within the three-day interval, nothing more.
    const soon = new Date(now.getTime() + 2 * DAY);
    expect((await runPracticeNudges({ ...deps, now: soon })).sent).toBe(0);
    // After the interval all three who practised before are idle long enough to be invited back.
    const later = new Date(now.getTime() + NUDGE_INTERVAL_MS + 60_000);
    const again = await runPracticeNudges({ ...deps, now: later });
    expect(again.sent).toBe(3);
    expect(await UserProgressModel.findOne({ userId: away._id }).lean()).toMatchObject({
      nudgesSent: 2,
    });
  });

  it('claims each candidate once even when runs overlap', async () => {
    const mail = createRecordingEmailProvider();
    await candidate({ daysAgo: [4] });
    const deps = { email: mail.provider, candidateUrl: 'https://i.test', linkKey, logger, now };
    await Promise.all([runPracticeNudges(deps), runPracticeNudges(deps)]);
    expect(mail.sent).toHaveLength(1);
  });

  it('sends nothing while email is off', async () => {
    await candidate({ daysAgo: [4] });
    const counts = await runPracticeNudges({
      email: null,
      candidateUrl: 'https://i.test',
      linkKey,
      logger,
      now,
    });
    expect(counts.sent).toBe(0);
  });
});

describe('certificate PDF', () => {
  it('renders once and stores it', async () => {
    const objects = new Map<string, Buffer>();
    const storage = { put: async (key: string, body: Buffer) => void objects.set(key, body) };
    const cert = await CertificateModel.create({
      userId: new mongoose.Types.ObjectId(),
      sessionId: new mongoose.Types.ObjectId(),
      reportRevision: 0,
      code: 'CPI-ABCD-EFGH-JKLM',
      candidateName: 'Asha',
      roleTitle: 'Backend Engineer',
      overall: 81,
      band: 'READY',
      completedAt: new Date('2026-09-20T10:00:00Z'),
      issuedAt: now,
    });
    const deps = { storage, candidateUrl: 'https://i.test' };
    expect(await processCertificatePdf(deps, String(cert._id))).toBe('rendered');
    const saved = await CertificateModel.findById(cert._id).lean();
    expect(saved!.pdf.status).toBe('READY');
    expect(objects.get(saved!.pdf.storageKey!)!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await processCertificatePdf(deps, String(cert._id))).toBe('skipped');
    expect(await processCertificatePdf(deps, String(new mongoose.Types.ObjectId()))).toBe(
      'skipped',
    );
  });
});
