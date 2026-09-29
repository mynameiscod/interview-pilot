import {
  JobTargetModel,
  ResumeModel,
  ResumeTailoringModel,
  type ExtractionRecord,
} from '@cbi/db';
import { ResumeMatchReport, ResumeTailoringSummary } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis, env: { RESUME_TAILOR_DAILY_LIMIT: '2' } });
});

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: 'get' | 'post', path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user.id) };
}

const READY: ExtractionRecord = {
  status: 'READY',
  errorCode: null,
  warnings: [],
  parser: 'text',
  ocrUsed: false,
  charCount: 100,
  attempts: 1,
  completedAt: new Date('2026-09-01T00:00:00Z'),
};

async function inputs(userId: string) {
  const resume = await ResumeModel.create({
    userId,
    storageKey: `resumes/${userId}/r.txt`,
    originalName: 'r.txt',
    mime: 'text/plain',
    size: 10,
    sha256: 'r'.repeat(64),
    rawText: 'Summary\nBackend engineer.\nSkills\nNode.js, Postgres, k8s\nEducation\nB.Tech 2020',
    structured: null,
    extraction: READY,
    layout: {
      pages: null,
      words: 300,
      tablesSuspected: false,
      columnsSuspected: false,
      imageOnly: false,
    },
  });
  const target = await JobTargetModel.create({
    userId,
    source: 'PASTE',
    rawText:
      'Backend role. Must have Node.js, PostgreSQL, Kubernetes and Kafka. 3+ years of experience.',
    extraction: READY,
  });
  return { resumeId: String(resume._id), jobTargetId: String(target._id) };
}

describe('resume match score', () => {
  it('scores my resume against my JD with itemised reasons', async () => {
    const { call, userId } = await candidate();
    const body = await inputs(userId);
    const res = await call('post', '/resume-tools/match').send(body).expect(200);
    const report = ResumeMatchReport.parse(res.body.data);
    expect(report.skills.mustHave.map((m) => [m.skill, m.matched])).toEqual([
      ['node.js', true],
      ['postgresql', true],
      ['kafka', false],
      ['kubernetes', true],
    ]);
    expect(report.reasons.some((r) => r.code === 'SYNONYM_MATCHED')).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('uses my edited revision and refuses unread, role-only or other people’s inputs', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const body = await inputs(asha.userId);
    await JobTargetModel.updateOne(
      { _id: body.jobTargetId },
      {
        $set: {
          edited: {
            title: 'Backend Engineer',
            seniority: null,
            companyName: null,
            location: null,
            employmentType: null,
            domain: null,
            experienceYears: null,
            responsibilities: [],
            skills: [{ name: 'Go', importance: 'MUST' }],
            qualifications: [],
          },
        },
      },
    );
    const edited = ResumeMatchReport.parse(
      (await asha.call('post', '/resume-tools/match').send(body).expect(200)).body.data,
    );
    expect(edited.usedEdits.jd).toBe(true);
    expect(edited.skills.mustHave.map((m) => m.skill)).toEqual(['Go']);

    await ravi.call('post', '/resume-tools/match').send(body).expect(404);
    await ResumeModel.updateOne(
      { _id: body.resumeId },
      { $set: { 'extraction.status': 'PENDING' } },
    );
    await asha.call('post', '/resume-tools/match').send(body).expect(409);
    const roleOnly = await JobTargetModel.create({
      userId: asha.userId,
      source: 'ROLE_ONLY',
      roleTitle: 'Backend Engineer',
      extraction: READY,
    });
    await asha
      .call('post', '/resume-tools/match')
      .send({ ...body, jobTargetId: String(roleOnly._id) })
      .expect(400);
  });
});

describe('tailoring suggestions', () => {
  it('queues once per unchanged inputs, enforces the daily quota and hides other users’ records', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const body = await inputs(asha.userId);
    const first = await asha.call('post', '/resume-tools/tailorings').send(body).expect(202);
    const tailoring = ResumeTailoringSummary.parse(first.body.data);
    expect(tailoring.status).toBe('PENDING');
    expect(t.jobs.jobs).toEqual([{ kind: 'tailor', id: tailoring.id }]);

    // Same inputs: the same record, no second AI call.
    const again = await asha.call('post', '/resume-tools/tailorings').send(body).expect(200);
    expect(again.body.data.id).toBe(tailoring.id);
    expect(t.jobs.jobs).toHaveLength(1);

    // An edit changes the inputs, so a new request is queued; the next hits the quota (2 a day).
    await ResumeModel.updateOne({ _id: body.resumeId }, { $set: { editedAt: new Date() } });
    await asha.call('post', '/resume-tools/tailorings').send(body).expect(202);
    await ResumeModel.updateOne(
      { _id: body.resumeId },
      { $set: { editedAt: new Date(Date.now() + 1000) } },
    );
    const quota = await asha.call('post', '/resume-tools/tailorings').send(body).expect(429);
    expect(quota.body.error.code).toBe('QUOTA_EXCEEDED');

    await asha.call('get', `/resume-tools/tailorings/${tailoring.id}`).expect(200);
    await ravi.call('get', `/resume-tools/tailorings/${tailoring.id}`).expect(404);
    expect(await ResumeTailoringModel.countDocuments({ userId: asha.userId })).toBe(2);
  });
});
