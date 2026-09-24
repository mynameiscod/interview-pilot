import {
  InterviewReportModel,
  InterviewSessionModel,
  mongoose,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import {
  CompareResult,
  ReportHistoryItem,
  ReportSummary,
  type InterviewState,
  type ReportContent,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
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

function content(
  overall: number | null,
  scores: Record<string, number | null>,
  endedAt: string,
): ReportContent {
  return {
    schemaVersion: 1,
    header: {
      title: 'Backend Engineer',
      companyName: 'Acme',
      mode: 'TEXT',
      language: 'auto',
      startedAt: endedAt,
      endedAt,
      durationSec: 1500,
      endReason: 'ROUND_ENDED',
    },
    overall: {
      score: overall,
      band:
        overall === null
          ? 'INSUFFICIENT_EVIDENCE'
          : overall >= 65
            ? 'READY_WITH_GAPS'
            : 'DEVELOPING',
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
      assessedWeight: 0.9,
    },
    summary: 'Solid API design, with gaps in system design.',
    dimensions: Object.entries(scores).map(([key, score]) => ({
      key,
      name: key.replace('-', ' '),
      category: 'TECHNICAL',
      weight: 50,
      score,
      rationale: null,
      evidence: [],
      fallback: false,
    })),
    strengths: [],
    gaps: [],
    rounds: [],
    coverage: [],
    plan: {
      next24h: [{ action: 'Write two examples.', why: 'Examples help.', dimensionKey: null }],
      next3Days: [{ action: 'Practise aloud.', why: 'Fluency helps.', dimensionKey: null }],
      next7Days: [{ action: 'Retake the interview.', why: 'See progress.', dimensionKey: null }],
    },
    previous: null,
    transcript: null,
    disclaimer: 'AI-generated estimate.',
  };
}

async function finished(
  userId: string,
  opts: {
    state?: InterviewState;
    overall?: number | null;
    scores?: Record<string, number | null>;
    endedAt?: string;
    roleKey?: string;
    pdf?: boolean;
  } = {},
) {
  const session = await InterviewSessionModel.create({
    userId,
    jobTargetId: new mongoose.Types.ObjectId(),
    templateId: new mongoose.Types.ObjectId(),
    state: opts.state ?? 'REPORT_READY',
    credit: { status: 'CONSUMED', lotId: null },
    processing: {
      run: 1,
      stage: null,
      status: 'DONE',
      completed: ['FINALIZE_TRANSCRIPT'],
      attempts: 0,
      error: null,
      updatedAt: new Date(),
      draft: {},
    },
  });
  if ((opts.state ?? 'REPORT_READY') === 'REPORT_READY') {
    const key = `reports/${userId}/${String(session._id)}/r0.pdf`;
    if (opts.pdf) await t.storage.storage.put(key, Buffer.from('%PDF-1.4 test'), 'application/pdf');
    await InterviewReportModel.create({
      sessionId: session._id,
      userId,
      revision: 0,
      scoreRevision: 0,
      content: content(
        opts.overall ?? 70,
        opts.scores ?? { 'api-design': 80, 'system-design': 60 },
        opts.endedAt ?? '2026-09-24T10:25:00.000Z',
      ),
      pdf: opts.pdf
        ? { status: 'READY', storageKey: key, generatedAt: new Date() }
        : { status: 'PENDING', storageKey: null, generatedAt: null },
      roleKey: opts.roleKey ?? 'role:backend',
      overall: opts.overall ?? 70,
      generatedAt: new Date(opts.endedAt ?? '2026-09-24T10:26:00.000Z'),
    });
  }
  return String(session._id);
}

describe('reports', () => {
  it('returns the latest candidate-visible revision to its owner only', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const id = await finished(asha.userId);
    const res = await asha.call('get', `/reports/${id}`).expect(200);
    const report = ReportSummary.parse(res.body.data);
    expect(report).toMatchObject({
      sessionId: id,
      revision: 0,
      pdfReady: false,
      credit: 'CONSUMED',
    });
    expect(report.content.overall.score).toBe(70);
    expect(res.headers['cache-control']).toBe('no-store');
    await ravi.call('get', `/reports/${id}`).expect(404);
    await asha.call('get', '/reports/nope').expect(404);
  });

  it('shows no report while evaluation is running', async () => {
    const asha = await candidate();
    const id = await finished(asha.userId, { state: 'PROCESSING' });
    await asha.call('get', `/reports/${id}`).expect(404);
    const progress = await asha.call('get', `/interviews/${id}/progress`).expect(200);
    expect(progress.body.data).toEqual({
      stage: null,
      status: 'DONE',
      completedStages: ['FINALIZE_TRANSCRIPT'],
      reportReady: false,
    });
  });

  it('serves the PDF once rendered', async () => {
    const asha = await candidate();
    const pending = await finished(asha.userId);
    const res = await asha.call('get', `/reports/${pending}/pdf`).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    const ready = await finished(asha.userId, { pdf: true });
    const pdf = await asha.call('get', `/reports/${ready}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`readiness-report-${ready}.pdf`);
    expect(Buffer.from(pdf.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('lists history newest first and compares attempts at the same role', async () => {
    const asha = await candidate();
    const first = await finished(asha.userId, {
      overall: 55,
      scores: { 'api-design': 50, 'system-design': 60 },
      endedAt: '2026-09-20T10:00:00.000Z',
    });
    const second = await finished(asha.userId, {
      overall: 72,
      scores: { 'api-design': 80, 'system-design': null },
      endedAt: '2026-09-24T10:00:00.000Z',
    });
    const other = await finished(asha.userId, {
      roleKey: 'role:qa',
      endedAt: '2026-09-22T10:00:00.000Z',
    });

    const history = z
      .array(ReportHistoryItem)
      .parse((await asha.call('get', '/reports').expect(200)).body.data);
    expect(history.map((h) => h.sessionId)).toEqual([second, other, first]);

    const compared = CompareResult.parse(
      (
        await asha
          .call('get', '/reports/compare')
          .query({ sessions: `${second},${first}` })
          .expect(200)
      ).body.data,
    );
    expect(compared.attempts.map((a) => a.sessionId)).toEqual([first, second]);
    expect(compared.dimensions).toEqual([
      { key: 'api-design', name: 'api design', scores: [50, 80], delta: 30 },
      { key: 'system-design', name: 'system design', scores: [60, null], delta: null },
    ]);

    await asha
      .call('get', '/reports/compare')
      .query({ sessions: `${first},${other}` })
      .expect(400);
    await asha.call('get', '/reports/compare').query({ sessions: first }).expect(400);
    await asha
      .call('get', '/reports/compare')
      .query({ sessions: `${first},${first}` })
      .expect(400);
  });
});

describe('feedback', () => {
  it('accepts one feedback per finished interview and updates it', async () => {
    const asha = await candidate();
    const draft = await finished(asha.userId, { state: 'READY' });
    const body = (sessionId: string, accuracy = 4) => ({
      sessionId,
      ratings: { usefulness: 5, accuracy, interviewQuality: 4 },
      freeText: 'Useful follow-up questions.',
      intendsRetake: true,
    });
    await asha.call('post', '/feedback').send(body(draft)).expect(409);
    const id = await finished(asha.userId);
    await asha.call('post', '/feedback').send(body(id)).expect(200);
    await asha.call('post', '/feedback').send(body(id, 2)).expect(200);
    const saved = await asha.call('get', `/feedback/${id}`).expect(200);
    expect(saved.body.data).toMatchObject({ ratings: { accuracy: 2 }, intendsRetake: true });
    await asha
      .call('post', '/feedback')
      .send({ ...body(id), ratings: { usefulness: 6, accuracy: 1, interviewQuality: 1 } })
      .expect(400);
    const ravi = await candidate('ravi@example.com');
    await ravi.call('post', '/feedback').send(body(id)).expect(404);
  });
});

describe('admin re-run', () => {
  async function admin(role: 'OPERATIONS_ADMIN' | 'CONTENT_ADMIN') {
    const email = `${role.toLowerCase()}@codebegun.com`;
    const user = await UserModel.create({ primaryEmail: email, adminRoles: [role] });
    await UserProfileModel.create({ userId: user._id });
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
    return (path: string) =>
      request(t.app)
        .post(`/api/v1/admin${path}`)
        .set('Origin', TEST_ORIGIN)
        .set('Authorization', `Bearer ${accessToken}`);
  }

  it('starts a new evaluation run for a PROCESSING interview (operations only)', async () => {
    const asha = await candidate();
    const stuck = await finished(asha.userId, { state: 'PROCESSING' });
    const done = await finished(asha.userId);
    await (
      await admin('CONTENT_ADMIN')
    )(`/interviews/${stuck}/reprocess`)
      .send({ reason: 'stuck' })
      .expect(403);
    const ops = await admin('OPERATIONS_ADMIN');
    await ops(`/interviews/${stuck}/reprocess`).send({}).expect(400);
    const res = await ops(`/interviews/${stuck}/reprocess`)
      .send({ reason: 'Recommendations stage failed' })
      .expect(202);
    expect(res.body.data).toEqual({ run: 1 });
    expect(t.jobs.jobs).toContainEqual({ kind: 'evaluate', id: stuck, rerun: true });
    await ops(`/interviews/${done}/reprocess`).send({ reason: 'again' }).expect(409);
  });
});
