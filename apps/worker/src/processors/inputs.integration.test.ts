import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildAiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import {
  CampaignModel,
  AiRouteModel,
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureAiCatalog,
  ensureIndexes,
  ensureLibraryCatalog,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  mongoose,
  ResumeModel,
  RoleBlueprintModel,
  RoleModel,
  type ExtractionRecord,
  type JobTargetRecord,
} from '@cbi/db';
import { buildDocx, buildDocxBomb, buildPdf, SAMPLE_RESUME_LINES } from '@cbi/documents/testing';
import { createMemoryStorage } from '@cbi/provider-adapters/testing';
import { DOCUMENT_MIME } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processInterviewAnalyze } from './analysis.js';
import { processJdExtract, processResumeExtract, type DocumentProcessorDeps } from './documents.js';

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
if (
  !MONGODB_URI ||
  !REDIS_URL ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need REDIS_URL and a MONGODB_URI whose database name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });
const redisUrl = new URL(REDIS_URL);
redisUrl.pathname = '/15';
const redis = createRedis(redisUrl.toString(), logger);
const ai = buildAiRuntime({
  env: {
    APP_ENV: 'test',
    AI_MOCK_MODE: true,
    AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    AI_SECRETS_KEY_ID: 'k1',
    AI_CONFIG_CACHE_TTL_SEC: 1,
  },
  logger,
  redis,
});
const { storage, objects } = createMemoryStorage();
const userId = new mongoose.Types.ObjectId();

let server: Server;
let serverUrl: string;
let page = { status: 200, type: 'text/html', body: '' };

const docs = (overrides: Partial<DocumentProcessorDeps['fetch']> = {}): DocumentProcessorDeps => ({
  storage,
  ai,
  logger,
  fetch: { timeoutMs: 5000, maxBytes: 256 * 1024, ...overrides },
});
const loopback = () => {
  const port = String((server.address() as AddressInfo).port);
  return docs({ isAllowedAddress: () => true, extraPorts: [port] });
};

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
  await redis.connect();
  server = createServer((_req, res) => {
    res.writeHead(page.status, { 'content-type': page.type });
    res.end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray()) {
    await db.collection(name).deleteMany({});
  }
  await redis.flushdb();
  objects.clear();
  await ensureAiCatalog({ mockMode: true });
  await ensureLibraryCatalog();
  ai.invalidateLocal();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnectMongo();
  await redis.quit();
});

async function uploadResume(body: Buffer) {
  const key = `resumes/${userId}/${new mongoose.Types.ObjectId()}.bin`;
  await storage.put(key, body, 'application/octet-stream');
  return ResumeModel.create({
    userId,
    storageKey: key,
    originalName: 'resume.pdf',
    mime: DOCUMENT_MIME.PDF,
    size: body.length,
    sha256: 'x'.repeat(64),
  });
}

const extraction = (
  status: ExtractionRecord['status'],
  errorCode: ExtractionRecord['errorCode'] = null,
): ExtractionRecord => ({
  status,
  errorCode,
  warnings: [],
  parser: null,
  ocrUsed: false,
  charCount: 0,
  attempts: 1,
  completedAt: new Date(),
});

const jd = (fields: Partial<JobTargetRecord>) =>
  JobTargetModel.create({ userId, source: 'PASTE', ...fields });

const JD_TEXT =
  'We are hiring a Backend Engineer to design REST APIs in Node.js and TypeScript, ' +
  'model data in PostgreSQL and run services on Kubernetes. 3+ years of experience required.';

describe('resume extraction', () => {
  it('extracts and structures a PDF resume', async () => {
    const resume = await uploadResume(buildPdf([SAMPLE_RESUME_LINES, SAMPLE_RESUME_LINES]));
    await processResumeExtract(docs(), String(resume._id), false);
    const saved = await ResumeModel.findById(resume._id).lean();
    expect(saved!.extraction).toMatchObject({ status: 'READY', parser: 'unpdf', attempts: 1 });
    expect(saved!.rawText).toContain('idempotent payments ledger');
    expect(saved!.structured).not.toBeNull();
    expect(saved!.extraction.warnings).not.toContain('STRUCTURE_UNAVAILABLE');
  });

  it('reads DOCX and records the detected type', async () => {
    const resume = await uploadResume(buildDocx(SAMPLE_RESUME_LINES));
    await processResumeExtract(docs(), String(resume._id), false);
    const saved = await ResumeModel.findById(resume._id).lean();
    expect(saved!.extraction.status).toBe('READY');
    expect(saved!.mime).toBe(DOCUMENT_MIME.DOCX);
  });

  it.each([
    ['a corrupt PDF', Buffer.from('%PDF-1.4\nnot really a pdf'), 'CORRUPT'],
    ['a zip bomb', buildDocxBomb(40), 'TOO_LARGE'],
    ['an executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'UNSUPPORTED_TYPE'],
  ])('marks %s FAILED without retrying', async (_name, body, code) => {
    const resume = await uploadResume(body);
    await expect(processResumeExtract(docs(), String(resume._id), false)).resolves.toBeUndefined();
    const saved = await ResumeModel.findById(resume._id).lean();
    expect(saved!.extraction).toMatchObject({ status: 'FAILED', errorCode: code });
    expect(saved!.rawText).toBeNull();
  });

  it('keeps the raw text when AI structuring is unavailable', async () => {
    await AiRouteModel.updateMany({}, { $set: { active: false } });
    ai.invalidateLocal();
    const resume = await uploadResume(buildPdf([SAMPLE_RESUME_LINES, SAMPLE_RESUME_LINES]));
    await processResumeExtract(docs(), String(resume._id), false);
    const saved = await ResumeModel.findById(resume._id).lean();
    expect(saved!.extraction.status).toBe('READY');
    expect(saved!.extraction.warnings).toContain('STRUCTURE_UNAVAILABLE');
    expect(saved!.structured).toBeNull();
  });

  it('ignores inputs that already finished (idempotent redelivery)', async () => {
    const resume = await uploadResume(buildPdf([SAMPLE_RESUME_LINES]));
    await ResumeModel.updateOne({ _id: resume._id }, { $set: { 'extraction.status': 'READY' } });
    await processResumeExtract(docs(), String(resume._id), false);
    expect((await ResumeModel.findById(resume._id).lean())!.extraction.attempts).toBe(0);
  });

  it('fails as INTERNAL only on the final attempt of a transient error', async () => {
    const resume = await ResumeModel.create({
      userId,
      storageKey: `resumes/${userId}/missing.pdf`,
      originalName: 'r.pdf',
      mime: DOCUMENT_MIME.PDF,
      size: 1,
      sha256: 'x'.repeat(64),
    });
    await expect(processResumeExtract(docs(), String(resume._id), false)).rejects.toThrow();
    expect((await ResumeModel.findById(resume._id).lean())!.extraction.status).toBe('PROCESSING');
    await expect(processResumeExtract(docs(), String(resume._id), true)).rejects.toThrow();
    expect((await ResumeModel.findById(resume._id).lean())!.extraction).toMatchObject({
      status: 'FAILED',
      errorCode: 'INTERNAL',
    });
  });
});

describe('job description extraction', () => {
  it('structures pasted text', async () => {
    const target = await jd({ source: 'PASTE', rawText: JD_TEXT });
    await processJdExtract(docs(), String(target._id), false);
    const saved = await JobTargetModel.findById(target._id).lean();
    expect(saved!.extraction).toMatchObject({ status: 'READY', parser: 'paste' });
    expect(saved!.structured).not.toBeNull();
  });

  it('fetches a URL and keeps only readable content', async () => {
    page = {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: `<html><head><title>Job</title><script>alert(1)</script></head><body>
        <nav>Home | Careers</nav><article><h1>Backend Engineer</h1><p>${JD_TEXT}</p></article></body></html>`,
    };
    const target = await jd({ source: 'URL', url: `${serverUrl}/jobs/1` });
    await processJdExtract(loopback(), String(target._id), false);
    const saved = await JobTargetModel.findById(target._id).lean();
    expect(saved!.extraction.status).toBe('READY');
    expect(saved!.rawText).toContain('design REST APIs');
    expect(saved!.rawText).not.toContain('alert(1)');
    expect(saved!.finalUrl).toBe(`${serverUrl}/jobs/1`);
  });

  it('blocks private addresses with the production policy', async () => {
    const target = await jd({ source: 'URL', url: `${serverUrl}/jobs/1` });
    await processJdExtract(docs(), String(target._id), false);
    expect((await JobTargetModel.findById(target._id).lean())!.extraction).toMatchObject({
      status: 'FAILED',
      errorCode: 'URL_BLOCKED',
    });
  });

  it.each([
    [{ status: 404, type: 'text/html', body: 'gone' }, 'FETCH_FAILED'],
    [{ status: 200, type: 'application/pdf', body: '%PDF' }, 'FETCH_FAILED'],
    [{ status: 200, type: 'text/html', body: '<p>Sign in to view this job</p>' }, 'NOT_READABLE'],
  ])('reports unusable pages (%j)', async (response, code) => {
    page = response;
    const target = await jd({ source: 'URL', url: `${serverUrl}/jobs/2` });
    await processJdExtract(loopback(), String(target._id), false);
    expect((await JobTargetModel.findById(target._id).lean())!.extraction).toMatchObject({
      status: 'FAILED',
      errorCode: code,
    });
  });

  it('retries server errors before giving up', async () => {
    page = { status: 503, type: 'text/html', body: 'busy' };
    const target = await jd({ source: 'URL', url: `${serverUrl}/jobs/3` });
    await expect(processJdExtract(loopback(), String(target._id), false)).rejects.toThrow();
    await expect(processJdExtract(loopback(), String(target._id), true)).rejects.toThrow();
    expect((await JobTargetModel.findById(target._id).lean())!.extraction).toMatchObject({
      status: 'FAILED',
      errorCode: 'FETCH_FAILED',
    });
  });
});

describe('interview analysis', () => {
  async function session(
    target: { _id: mongoose.Types.ObjectId },
    extra: Record<string, unknown> = {},
  ) {
    const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
    return InterviewSessionModel.create({
      userId,
      jobTargetId: target._id,
      templateId: template!._id,
      state: 'ROLE_ANALYSIS',
      stateHistory: [{ from: 'DRAFT', to: 'ROLE_ANALYSIS', at: new Date(), reason: null }],
      ...extra,
    });
  }
  const readyTarget = (fields: Partial<JobTargetRecord>) =>
    jd({ extraction: extraction('READY'), ...fields });
  const analyze = (id: unknown, now?: Date) =>
    processInterviewAnalyze({ ai, logger, now: now ? () => now : undefined }, String(id), false);

  it('uses the canonical blueprint for a bare library role', async () => {
    const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
    const target = await readyTarget({ source: 'ROLE_ONLY', roleId: role!._id });
    const s = await session(target);
    expect(await analyze(s._id)).toEqual({ status: 'done' });
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('READY');
    expect(String(saved!.blueprintId)).toBe(String(role!.activeBlueprintId));
    expect(saved!.analysis!.blueprint.origin).toBe('CANONICAL');
    expect(saved!.analysis!.matchedRole).toEqual({ id: String(role!._id), title: role!.title });
    expect(saved!.analysis!.plannedRounds.length).toBeGreaterThan(0);
    expect(saved!.promptVersions['role.analyze']).toBe(1);
    expect(saved!.stateVersion).toBe(1);
  });

  it('generates a tailored blueprint when there is a job description', async () => {
    const target = await readyTarget({ source: 'PASTE', rawText: JD_TEXT });
    const s = await session(target);
    await analyze(s._id);
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('READY');
    expect(saved!.analysis!.blueprint.origin).toBe('AI_GENERATED');
    expect(saved!.analysis!.inputs).toEqual({ resume: false, jd: true, companyPatterns: false });
    const blueprint = await RoleBlueprintModel.findById(saved!.blueprintId).lean();
    expect(blueprint).toMatchObject({ roleId: null, userId, sourceJobTargetId: target._id });
    expect(blueprint!.content.competencies.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(saved!.promptVersions).toMatchObject({ 'role.analyze': 1, 'blueprint.generate': 1 });
  });

  it("uses a campaign's pinned blueprint even with a job description", async () => {
    const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
    const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
    const campaign = await CampaignModel.create({
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
      createdBy: userId,
    });
    const target = await readyTarget({ source: 'PASTE', rawText: JD_TEXT, roleId: role!._id });
    const s = await session(target, { campaignId: campaign._id });
    await analyze(s._id);
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('READY');
    expect(String(saved!.blueprintId)).toBe(String(role!.activeBlueprintId));
    expect(saved!.analysis!.blueprint.origin).toBe('CANONICAL');
    expect(saved!.promptVersions['blueprint.generate']).toBeUndefined();
    expect(await RoleBlueprintModel.countDocuments({ origin: 'AI_GENERATED' })).toBe(0);
  });

  it('falls back to the chosen role when AI is unavailable', async () => {
    await AiRouteModel.updateMany({}, { $set: { active: false } });
    ai.invalidateLocal();
    const role = await RoleModel.findOne({ slug: 'qa-engineer' }).lean();
    const target = await readyTarget({ source: 'PASTE', rawText: JD_TEXT, roleId: role!._id });
    const s = await session(target);
    await analyze(s._id);
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('READY');
    expect(saved!.analysis!.blueprint.origin).toBe('CANONICAL');
    expect(saved!.analysis!.detectedRole.title).toBe('QA Engineer');
  });

  it('fails with AI_UNAVAILABLE when there is nothing to fall back to', async () => {
    await AiRouteModel.updateMany({}, { $set: { active: false } });
    ai.invalidateLocal();
    const target = await readyTarget({ source: 'ROLE_ONLY', roleTitle: 'Astronaut' });
    const s = await session(target);
    await analyze(s._id);
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('FAILED');
    expect(saved!.failure!.code).toBe('AI_UNAVAILABLE');
  });

  it('waits for inputs that are still extracting, then times out', async () => {
    const target = await jd({ source: 'PASTE', rawText: JD_TEXT });
    const s = await session(target);
    expect(await analyze(s._id)).toEqual({ status: 'wait', retryInMs: 2000 });
    expect((await InterviewSessionModel.findById(s._id).lean())!.state).toBe('ROLE_ANALYSIS');
    await analyze(s._id, new Date(Date.now() + 10 * 60_000));
    const saved = await InterviewSessionModel.findById(s._id).lean();
    expect(saved!.state).toBe('FAILED');
    expect(saved!.failure!.code).toBe('INPUT_TIMEOUT');
  });

  it('fails with INPUT_FAILED when an input could not be read', async () => {
    const target = await jd({
      source: 'URL',
      url: 'https://example.com/job',
      extraction: extraction('FAILED', 'URL_BLOCKED'),
    });
    const s = await session(target);
    await analyze(s._id);
    expect((await InterviewSessionModel.findById(s._id).lean())!.failure!.code).toBe(
      'INPUT_FAILED',
    );
  });

  it('never reads another user’s inputs', async () => {
    const target = await readyTarget({ source: 'PASTE', rawText: JD_TEXT });
    const s = await session(target, { userId: new mongoose.Types.ObjectId() });
    await analyze(s._id);
    expect((await InterviewSessionModel.findById(s._id).lean())!.failure!.code).toBe(
      'INPUT_FAILED',
    );
  });

  it('ignores sessions that already left ROLE_ANALYSIS', async () => {
    const target = await readyTarget({ source: 'PASTE', rawText: JD_TEXT });
    const s = await session(target, { state: 'CANCELLED' });
    expect(await analyze(s._id)).toEqual({ status: 'done' });
    expect((await InterviewSessionModel.findById(s._id).lean())!.state).toBe('CANCELLED');
  });
});
