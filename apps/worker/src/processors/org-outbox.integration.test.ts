import { createSecretBox } from '@cbi/ai-core';
import { createLogger } from '@cbi/config';
import {
  CampaignInviteModel,
  CampaignModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  inviteTokenContext,
  mongoose,
  OrgModel,
  OrgWebhookModel,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDeliveryModel,
  webhookBackoffMs,
  webhookBody,
  webhookSecretContext,
} from '@cbi/db';
import type { EmailMessage } from '@cbi/provider-adapters';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInviteMailer } from './invite-mailer.js';
import { runWebhookDispatch, type PostJson } from './webhook-dispatch.js';

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
const secrets = createSecretBox({ currentKeyId: 'k1', keys: { k1: Buffer.alloc(32, 3) } });
const HOUR = 3600_000;
const t0 = new Date('2026-09-29T10:00:00.000Z');

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

const userId = new mongoose.Types.ObjectId();

async function org(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  return OrgModel.create({
    name: 'Acme Labs',
    type: 'EMPLOYER',
    status,
    seats: 5,
    interviewQuota: { total: null, used: 0 },
    wallet: { balance: 0, allocated: 0 },
    mfaRequired: false,
    createdBy: userId,
  });
}

async function campaign(orgId: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return CampaignModel.create({
    name: 'Backend hiring',
    status: 'ACTIVE',
    companyName: 'Acme Labs',
    roleId: new mongoose.Types.ObjectId(),
    roleTitle: 'Backend Engineer',
    blueprintId: new mongoose.Types.ObjectId(),
    blueprintVersion: 1,
    templateId: new mongoose.Types.ObjectId(),
    templateKey: 'standard-practice',
    templateVersion: 1,
    templateName: 'Standard',
    modes: ['TEXT'],
    languages: ['en'],
    window: { startAt: new Date(t0.getTime() - HOUR), endAt: null },
    proctoring: { recording: 'OFF', tabSwitchTracking: false },
    candidateSeesReport: true,
    tokenHash: String(Math.random()),
    tokenHint: 'abcd',
    orgId,
    reminders: { enabled: true, max: 2, intervalHours: 48 },
    createdBy: userId,
    ...overrides,
  });
}

async function invite(
  campaignId: mongoose.Types.ObjectId,
  orgId: mongoose.Types.ObjectId,
  email: string,
  overrides: Record<string, unknown> = {},
) {
  const _id = new mongoose.Types.ObjectId();
  const token = `tok_${email.split('@')[0]}_0123456789`;
  await CampaignInviteModel.create({
    _id,
    orgId,
    campaignId,
    email,
    name: null,
    language: 'hi',
    tags: { batch: null, branch: null, year: null },
    status: 'PENDING',
    tokenHash: `hash-${email}`,
    tokenEnc: secrets.encrypt(token, inviteTokenContext(String(_id))),
    remindersSent: 0,
    nextSendAt: t0,
    sendAttempts: 0,
    createdBy: userId,
    ...overrides,
  });
  return { _id, token };
}

function recordingEmail() {
  const sent: EmailMessage[] = [];
  const state = { fail: false };
  return {
    sent,
    state,
    provider: {
      name: 'recording',
      async send(m: EmailMessage) {
        if (state.fail) throw new Error('smtp down');
        sent.push(m);
        return {};
      },
    },
  };
}

describe('invite mailer', () => {
  it('sends the invite, then two reminders at the interval, then nothing', async () => {
    const o = await org();
    const c = await campaign(o._id);
    const { token } = await invite(c._id, o._id, 'asha@example.com');
    const email = recordingEmail();
    let now = t0;
    const run = () =>
      runInviteMailer({
        email: email.provider,
        secrets,
        candidateUrl: 'https://interview.test/',
        logger,
        now: () => now,
      });

    expect(await run()).toMatchObject({ invites: 1 });
    expect(email.sent[0]).toMatchObject({ to: 'asha@example.com' });
    expect(email.sent[0]!.text).toContain(`https://interview.test/campaign/i/${token}`);
    expect(email.sent[0]!.subject).toContain('आमंत्रित'); // Hindi, as chosen for the invitee
    let row = await CampaignInviteModel.findOne({ email: 'asha@example.com' }).lean();
    expect(row).toMatchObject({ status: 'SENT', sentAt: t0 });
    expect(row!.nextSendAt).toEqual(new Date(t0.getTime() + 48 * HOUR));

    // Nothing before the interval.
    now = new Date(t0.getTime() + 47 * HOUR);
    expect(await run()).toMatchObject({ invites: 0, reminders: 0 });

    now = new Date(t0.getTime() + 48 * HOUR);
    expect(await run()).toMatchObject({ reminders: 1 });
    now = new Date(t0.getTime() + 96 * HOUR);
    expect(await run()).toMatchObject({ reminders: 1 });
    row = await CampaignInviteModel.findOne({ email: 'asha@example.com' }).lean();
    expect(row).toMatchObject({ remindersSent: 2, nextSendAt: null });
    now = new Date(t0.getTime() + 500 * HOUR);
    await run();
    expect(email.sent).toHaveLength(3);
    expect(email.sent[1]!.subject).toContain('रिमाइंडर');
  });

  it('skips joined and revoked invites and waits for draft campaigns', async () => {
    const o = await org();
    const active = await campaign(o._id);
    const draft = await campaign(o._id, { status: 'DRAFT' });
    await invite(active._id, o._id, 'joined@example.com', { status: 'JOINED' });
    await invite(active._id, o._id, 'revoked@example.com', { status: 'REVOKED' });
    await invite(draft._id, o._id, 'later@example.com');
    const email = recordingEmail();
    const counts = await runInviteMailer({
      email: email.provider,
      secrets,
      candidateUrl: 'https://interview.test',
      logger,
      now: () => t0,
    });
    expect(counts).toMatchObject({ invites: 0, stopped: 2, deferred: 1 });
    expect(email.sent).toHaveLength(0);
    const later = await CampaignInviteModel.findOne({ email: 'later@example.com' }).lean();
    expect(later!.nextSendAt!.getTime()).toBeGreaterThan(t0.getTime());
  });

  it('retries a failed send and marks the invite FAILED after three attempts', async () => {
    const o = await org();
    const c = await campaign(o._id);
    await invite(c._id, o._id, 'asha@example.com');
    const email = recordingEmail();
    email.state.fail = true;
    let now = t0;
    for (let i = 0; i < 3; i++) {
      await runInviteMailer({
        email: email.provider,
        secrets,
        candidateUrl: 'https://interview.test',
        logger,
        now: () => now,
      });
      now = new Date(now.getTime() + HOUR);
    }
    const row = await CampaignInviteModel.findOne({ email: 'asha@example.com' }).lean();
    expect(row).toMatchObject({ status: 'FAILED', nextSendAt: null });
    expect(row!.lastError).toBe('The email could not be sent.');
  });

  it('sends nothing while email is not configured', async () => {
    const o = await org();
    const c = await campaign(o._id);
    await invite(c._id, o._id, 'asha@example.com');
    const email = recordingEmail();
    await runInviteMailer({
      email: email.provider,
      emailEnabled: () => false,
      secrets,
      candidateUrl: 'https://interview.test',
      logger,
    });
    expect((await CampaignInviteModel.findOne({}).lean())!.status).toBe('PENDING');
  });
});

describe('webhook dispatch', () => {
  async function hook(orgId: mongoose.Types.ObjectId, active = true) {
    const w = new OrgWebhookModel({
      orgId,
      url: 'https://hooks.acme.test/cb',
      events: ['candidate.stage_changed'],
      active,
      description: null,
      secretHint: 'whsec_abcd',
      createdBy: userId,
    });
    w.secret = secrets.encrypt('whsec_secret', webhookSecretContext(String(w._id)));
    await w.save();
    return w;
  }

  async function delivery(orgId: mongoose.Types.ObjectId, webhookId: mongoose.Types.ObjectId) {
    return WebhookDeliveryModel.create({
      orgId,
      webhookId,
      event: 'candidate.stage_changed',
      body: webhookBody('candidate.stage_changed', { applicationId: 'a1' }, t0),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: t0,
    });
  }

  it('signs each attempt, retries failures with backoff and records delivery', async () => {
    const o = await org();
    const w = await hook(o._id);
    const d = await delivery(o._id, w._id);
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const replies = [500, 204];
    const post: PostJson = async (url, body, headers) => {
      calls.push({ url, body, headers });
      return { status: replies.shift()! };
    };
    let now = t0;
    const run = () => runWebhookDispatch({ post, secrets, logger, now: () => now });

    expect(await run()).toEqual({ DELIVERED: 0, PENDING: 1, FAILED: 0 });
    let row = await WebhookDeliveryModel.findById(d._id).lean();
    expect(row).toMatchObject({ attempts: 1, lastStatusCode: 500, lastError: 'HTTP 500' });
    expect(row!.nextAttemptAt).toEqual(new Date(t0.getTime() + webhookBackoffMs(1)));
    // Not due yet: nothing is sent.
    expect(await run()).toEqual({ DELIVERED: 0, PENDING: 0, FAILED: 0 });

    now = new Date(t0.getTime() + webhookBackoffMs(1));
    expect(await run()).toEqual({ DELIVERED: 1, PENDING: 0, FAILED: 0 });
    row = await WebhookDeliveryModel.findById(d._id).lean();
    expect(row).toMatchObject({ status: 'DELIVERED', attempts: 2, nextAttemptAt: null });

    expect(calls).toHaveLength(2);
    const { headers, body, url } = calls[1]!;
    expect(url).toBe('https://hooks.acme.test/cb');
    expect(headers['x-cb-event']).toBe('candidate.stage_changed');
    expect(headers['x-cb-delivery']).toBe(String(d._id));
    expect(verifyWebhookSignature('whsec_secret', headers['x-cb-signature']!, body, now)).toBe(
      true,
    );
    // Every retry sends the same body.
    expect(calls[0]!.body).toBe(body);
  });

  it('gives up after the last attempt and never sends for suspended organisations', async () => {
    const o = await org();
    const w = await hook(o._id);
    const d = await delivery(o._id, w._id);
    await WebhookDeliveryModel.updateOne(
      { _id: d._id },
      { $set: { attempts: WEBHOOK_MAX_ATTEMPTS - 1 } },
    );
    const post: PostJson = async () => {
      throw new Error('connection refused');
    };
    expect(await runWebhookDispatch({ post, secrets, logger, now: () => t0 })).toEqual({
      DELIVERED: 0,
      PENDING: 0,
      FAILED: 1,
    });
    expect((await WebhookDeliveryModel.findById(d._id).lean())!.lastError).toBe('Delivery failed');

    const suspended = await org('SUSPENDED');
    const w2 = await hook(suspended._id);
    await delivery(suspended._id, w2._id);
    let posted = 0;
    await runWebhookDispatch({
      post: async () => {
        posted++;
        return { status: 204 };
      },
      secrets,
      logger,
      now: () => t0,
    });
    expect(posted).toBe(0);
  });
});
