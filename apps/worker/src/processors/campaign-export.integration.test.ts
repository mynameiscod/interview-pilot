import { createLogger } from '@cbi/config';
import {
  CampaignApplicationModel,
  CampaignExportModel,
  CampaignModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  ensureLibraryCatalog,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  mongoose,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
  type CampaignRecord,
} from '@cbi/db';
import { createMemoryStorage } from '@cbi/provider-adapters/testing';
import type { InterviewState } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readZip } from '../exports/zip-writer.js';
import { processCampaignPackage, sweepCampaignExports } from './campaign-export.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error('Integration tests need a MONGODB_URI whose database name contains "test".');
}

const logger = createLogger({ service: 'test', level: 'silent' });
const { storage, objects } = createMemoryStorage();
const adminId = new mongoose.Types.ObjectId();
const HOUR = 3600_000;

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
});

beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray()) {
    await db.collection(name).deleteMany({});
  }
  objects.clear();
  await ensureLibraryCatalog();
});

afterAll(async () => {
  await disconnectMongo();
});

async function createCampaign(): Promise<CampaignRecord> {
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const created = await CampaignModel.create({
    name: 'Hiring',
    companyName: 'Acme',
    roleId: role!._id,
    roleTitle: role!.title,
    blueprintId: role!.activeBlueprintId!,
    blueprintVersion: 1,
    templateId: template!._id,
    templateKey: template!.key,
    templateVersion: template!.version,
    templateName: template!.content.name,
    modes: ['TEXT'],
    languages: ['en'],
    window: { startAt: new Date(), endAt: null },
    proctoring: { recording: 'OFF', tabSwitchTracking: false },
    candidateSeesReport: true,
    tokenHash: 'h'.repeat(64),
    tokenHint: 'abcd',
    createdBy: adminId,
  });
  return created.toObject() as CampaignRecord;
}

/** A candidate who joined; with `overall`, also scored with a report (and its PDF). */
async function candidate(
  campaign: CampaignRecord,
  name: string,
  opts: { state?: InterviewState; overall?: number; pdf?: boolean } = {},
) {
  const user = await UserModel.create({ primaryEmail: `${name.toLowerCase()}@example.com` });
  await UserProfileModel.create({ userId: user._id, displayName: name });
  const target = await JobTargetModel.create({
    userId: user._id,
    source: 'ROLE_ONLY',
    roleId: campaign.roleId,
    roleTitle: campaign.roleTitle,
    extraction: { status: 'READY', parser: 'none', charCount: 0, completedAt: new Date() },
  });
  const session = await InterviewSessionModel.create({
    userId: user._id,
    jobTargetId: target._id,
    templateId: campaign.templateId,
    mode: 'TEXT',
    language: 'en',
    state: opts.state ?? 'READY',
    campaignId: campaign._id,
    endedAt: opts.overall === undefined ? null : new Date(),
  });
  await CampaignApplicationModel.create({
    campaignId: campaign._id,
    userId: user._id,
    sessionId: session._id,
    joinedAt: new Date(),
  });
  if (opts.overall !== undefined) {
    const blueprint = await RoleBlueprintModel.findById(campaign.blueprintId).lean();
    const [first] = blueprint!.content.competencies;
    await InterviewScoreModel.create({
      sessionId: session._id,
      userId: user._id,
      revision: 0,
      dimensions: [
        {
          key: first!.key,
          name: first!.name,
          category: 'TECHNICAL',
          weight: 100,
          score: opts.overall,
          aiScore: opts.overall,
          adjusted: false,
          fallback: false,
          rationale: null,
          evidenceIds: [],
        },
      ],
      overall: opts.overall,
      band: 'READY_WITH_GAPS',
      confidence: {
        level: 'MEDIUM',
        value: 0.6,
        factors: {
          independentQuestions: 0.8,
          practicalEvidence: 0.4,
          consistency: 0.7,
          completeness: 0.9,
        },
      },
      assessedWeight: 1,
      templateId: campaign.templateId,
      promptVersions: {},
      createdBy: 'AI',
      reason: null,
    });
    const pdfKey = `reports/${String(session._id)}/0.pdf`;
    if (opts.pdf) await storage.put(pdfKey, Buffer.from(`%PDF ${name}`), 'application/pdf');
    await InterviewReportModel.create({
      sessionId: session._id,
      userId: user._id,
      revision: 0,
      scoreRevision: 0,
      content: { summary: `Report for ${name}` } as never,
      pdf: opts.pdf
        ? { status: 'READY', storageKey: pdfKey, generatedAt: new Date() }
        : { status: 'PENDING', storageKey: null, generatedAt: null },
      roleKey: 'role:backend',
      overall: opts.overall,
      generatedAt: new Date(),
    });
  }
  return String(session._id);
}

const queued = (campaign: CampaignRecord, total: number) =>
  CampaignExportModel.create({
    campaignId: campaign._id,
    requestedBy: adminId,
    status: 'QUEUED',
    progress: { done: 0, total },
    fileName: `campaign-${String(campaign._id)}-package.zip`,
    expiresAt: new Date(Date.now() + 6 * HOUR),
  });

describe('campaign package exports', () => {
  it('streams every candidate and their latest report into a ZIP in storage', async () => {
    const campaign = await createCampaign();
    const asha = await candidate(campaign, 'Asha', {
      state: 'REPORT_READY',
      overall: 80,
      pdf: true,
    });
    const ravi = await candidate(campaign, 'Ravi', { state: 'REPORT_READY', overall: 60 });
    await candidate(campaign, 'Meera');
    const exp = await queued(campaign, 3);

    const deps = { storage, logger, retentionHours: 24 };
    await expect(processCampaignPackage(deps, String(exp._id), false)).resolves.toBe('ready');

    const saved = await CampaignExportModel.findById(exp._id).lean();
    expect(saved).toMatchObject({ status: 'READY', progress: { done: 3, total: 3 } });
    expect(saved!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    const files = readZip(objects.get(saved!.storageKey!)!.body);
    expect([...files.keys()]).toEqual([
      'results.csv',
      'campaign.json',
      `reports/asha-${asha}.json`,
      `reports/asha-${asha}.pdf`,
      `reports/ravi-${ravi}.json`,
    ]);
    const csv = files.get('results.csv')!.toString('utf8').slice(1).split('\r\n');
    // Best first; unscored last.
    expect(csv.slice(1, 4).map((l) => l.split(',')[0])).toEqual(['Asha', 'Ravi', 'Meera']);
    expect(files.get(`reports/asha-${asha}.pdf`)!.toString()).toBe('%PDF Asha');
    expect(saved!.sizeBytes).toBe(objects.get(saved!.storageKey!)!.body.length);

    // Running it again (a duplicate job) changes nothing.
    await expect(processCampaignPackage(deps, String(exp._id), false)).resolves.toBe('skipped');
  });

  it('deletes files past retention and fails exports stuck in the queue', async () => {
    const campaign = await createCampaign();
    await candidate(campaign, 'Asha');
    const done = await queued(campaign, 1);
    await processCampaignPackage({ storage, logger, retentionHours: 1 }, String(done._id), false);
    const key = (await CampaignExportModel.findById(done._id).lean())!.storageKey!;
    const stuck = await queued(campaign, 1);

    const later = new Date(Date.now() + 7 * HOUR);
    const result = await sweepCampaignExports({ storage, logger, now: later });
    expect(result).toEqual({ expired: 1, stuck: 1, errors: 0 });
    expect(objects.has(key)).toBe(false);
    expect(await CampaignExportModel.findById(done._id).lean()).toMatchObject({
      status: 'EXPIRED',
      storageKey: null,
    });
    expect((await CampaignExportModel.findById(stuck._id).lean())!.status).toBe('FAILED');
  });
});
