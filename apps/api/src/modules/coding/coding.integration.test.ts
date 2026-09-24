import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AuditLogModel,
  CodingAttemptModel,
  ensureLibraryCatalog,
  ensureProblemBank,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import {
  CodingWorkspace,
  ProblemSummary,
  RT_NAMESPACE,
  RtEvent,
  type AdminRole,
  type InterviewSnapshot,
  type LiveQuestion,
  type RtAck,
} from '@cbi/shared-types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRealtime } from '../../realtime.js';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { bootstrapAi } from '../ai/ai-bootstrap.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;
let server: Server;
let realtime: Awaited<ReturnType<typeof createRealtime>>;
let baseUrl: string;
const sockets: Socket[] = [];

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await bootstrapAi({
    env: t.env,
    ai: t.container.ai,
    audit: t.container.audit,
    logger: t.container.logger,
  });
  await ensureLibraryCatalog();
  await ensureProblemBank();
  server = createServer(t.app);
  realtime = await createRealtime({ server, container: t.container, redis });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await realtime.close();
});

type Method = 'get' | 'post' | 'put';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}
type Call = Awaited<ReturnType<typeof candidate>>['call'];

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  return (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
}

/** A READY text interview whose first round is a coding round (then a short wrap-up). */
async function codingInterview(userId: string) {
  const base = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const [template] = await InterviewTemplateModel.create([
    {
      key: `coding-${userId}`,
      version: 1,
      status: 'ACTIVE',
      content: {
        ...base!.content,
        rounds: [
          {
            type: 'CODING',
            durationSec: 900,
            questionCount: 1,
            difficulty: 'EASY',
            followUpDepth: 0,
            minEvidence: 0,
          },
          {
            type: 'WRAP_UP',
            durationSec: 120,
            questionCount: 1,
            difficulty: 'EASY',
            followUpDepth: 0,
            minEvidence: 0,
          },
        ],
      },
    },
  ]);
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const target = await JobTargetModel.create({
    userId,
    source: 'ROLE_ONLY',
    roleId: role!._id,
    roleTitle: role!.title,
    extraction: { status: 'READY' },
  });
  const s = await InterviewSessionModel.create({
    userId,
    jobTargetId: target._id,
    templateId: template!._id,
    blueprintId: blueprint!._id,
    state: 'READY',
    mode: 'TEXT',
  });
  return String(s._id);
}

async function startAndJoin(token: string, call: Call, id: string) {
  await call('post', `/interviews/${id}/start`).expect(200);
  const socket = connect(`${baseUrl}${RT_NAMESPACE}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const pushed = new Promise<LiveQuestion>((resolve) => socket.once(RtEvent.QUESTION, resolve));
  const ack = (await socket
    .timeout(15_000)
    .emitWithAck(RtEvent.JOIN, { sessionId: id, lastSeq: 0 })) as RtAck;
  if (!ack.ok) throw new Error(`join failed: ${ack.code}`);
  const snapshot = ack.snapshot as InterviewSnapshot;
  const question = snapshot.currentQuestion ?? (await pushed);
  return { socket, question };
}

const nextQuestion = (socket: Socket) =>
  new Promise<LiveQuestion>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no next question')), 30_000);
    socket.once(RtEvent.QUESTION, (q: LiveQuestion) => {
      clearTimeout(timer);
      resolve(q);
    });
  });

describe('coding round', () => {
  it('asks a bank problem, keeps hidden tests on the server and runs visible tests', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await codingInterview(userId);
    const { socket, question } = await startAndJoin(accessToken, call, id);
    expect(question.coding).toMatchObject({ title: expect.any(String) });
    expect(question.text).toMatch(/^Coding problem: /);

    const res = await call('get', `/interviews/${id}/coding/${question.questionId}`).expect(200);
    const ws = CodingWorkspace.parse(res.body.data);
    expect(ws.problem.difficulty).toBe('EASY');
    expect(ws.problem.hiddenTestCount).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('hiddenTests');
    expect(ws.code).toBe(ws.problem.starterCode[ws.language]);

    // The chat box cannot answer a coding question.
    const chat = (await socket.timeout(10_000).emitWithAck(RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: question.questionId,
      text: 'print(1)',
      clientMsgId: 'chat-answer-0001',
    })) as RtAck;
    expect(chat).toMatchObject({ ok: false, code: 'INVALID_STATE' });

    await call('put', `/interviews/${id}/coding/${question.questionId}`)
      .send({ language: 'python', code: 'print("draft")' })
      .expect(200);
    await call('put', `/interviews/${id}/coding/${question.questionId}`)
      .send({ language: 'rust', code: 'x' })
      .expect(400);
    const run = await call('post', `/interviews/${id}/coding/${question.questionId}/run`)
      .send({ language: 'python', code: 'print("draft")' })
      .expect(200);
    const afterRun = CodingWorkspace.parse(run.body.data);
    expect(afterRun.lastRun).toMatchObject({ verdict: 'ACCEPTED' });
    expect(afterRun.lastRun!.tests.every((x) => !x.hidden)).toBe(true);
    expect(afterRun.lastRun!.total).toBe(ws.problem.visibleTests.length);

    // Submit: visible + hidden tests; hidden outcomes carry no data; the interview moves on.
    const next = nextQuestion(socket);
    const submitted = await call('post', `/interviews/${id}/coding/${question.questionId}/submit`)
      .send({ language: 'python', code: '# MOCK_PASS_3\nprint(1)' })
      .expect(200);
    const sub = CodingWorkspace.parse(submitted.body.data).submission!;
    expect(sub).toMatchObject({ judgeUnavailable: false, result: { passed: 3 } });
    const hidden = sub.result!.tests.filter((x) => x.hidden);
    expect(hidden.length).toBe(ws.problem.hiddenTestCount);
    expect(hidden.every((x) => x.stdout === null && x.expectedOutput === null)).toBe(true);
    const turn = (await InterviewTurnModel.findOne({ questionId: question.questionId }).lean())!;
    expect(turn.answer!.text).toMatch(/3 of \d+ tests passed/);
    expect(turn.answer!.text).toContain('MOCK_PASS_3');
    expect((await next).coding).toBeNull(); // the wrap-up question

    // A second submit is a no-op; editing after submitting is refused.
    await call('post', `/interviews/${id}/coding/${question.questionId}/submit`)
      .send({ language: 'python', code: 'print(2)' })
      .expect(200);
    expect(await CodingAttemptModel.countDocuments({ sessionId: id })).toBe(1);
    await call('put', `/interviews/${id}/coding/${question.questionId}`)
      .send({ language: 'python', code: 'print(3)' })
      .expect(409);
    expect(await AuditLogModel.countDocuments({ action: 'interview.code_submitted' })).toBe(1);

    const other = await candidate('ravi@example.com');
    await other.call('get', `/interviews/${id}/coding/${question.questionId}`).expect(404);
  });

  it('keeps the interview going when the judge is down (run unavailable, submit still works)', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await codingInterview(userId);
    const { socket, question } = await startAndJoin(accessToken, call, id);
    t.judge.setDown(true);

    const run = await call('post', `/interviews/${id}/coding/${question.questionId}/run`)
      .send({ language: 'python', code: 'print(input())' })
      .expect(503);
    expect(run.body.error.code).toBe('JUDGE_UNAVAILABLE');
    // The code was saved anyway, and the interview is untouched.
    const ws = CodingWorkspace.parse(
      (await call('get', `/interviews/${id}/coding/${question.questionId}`)).body.data,
    );
    expect(ws.code).toBe('print(input())');
    expect((await InterviewSessionModel.findById(id).lean())!.state).toBe('ACTIVE');

    const next = nextQuestion(socket);
    const submitted = await call('post', `/interviews/${id}/coding/${question.questionId}/submit`)
      .send({ language: 'python', code: 'print(input())' })
      .expect(200);
    expect(CodingWorkspace.parse(submitted.body.data).submission).toMatchObject({
      judgeUnavailable: true,
      result: null,
    });
    const turn = (await InterviewTurnModel.findOne({ questionId: question.questionId }).lean())!;
    expect(turn.answer!.text).toMatch(/judge was unavailable/);
    const q2 = await next;
    expect(q2.coding).toBeNull(); // the wrap-up question
    expect((await InterviewSessionModel.findById(id).lean())!.state).toBe('ACTIVE');
  });

  it('lets library admins manage the problem bank', async () => {
    const support = await adminAs(['SUPPORT_ADMIN']);
    await support('get', '/problems').expect(403);
    const content = await adminAs(['CONTENT_ADMIN']);
    const list = z
      .array(ProblemSummary)
      .parse((await content('get', '/problems').expect(200)).body.data);
    expect(list.length).toBeGreaterThanOrEqual(4);
    const base = list.find((p) => p.key === 'balanced-brackets')!;
    expect(base.hiddenTests.length).toBeGreaterThan(0); // admins see hidden tests
    const { id: _id, key, version: _v, active: _a, createdAt: _c, ...contentFields } = base;
    const created = await content('post', '/problems')
      .send({
        key,
        content: { ...contentFields, title: 'Balanced brackets (v2)' },
        reason: 'Clearer wording',
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ version: 2, active: false });
    await content('post', `/problems/${created.body.data.id}/activate`)
      .send({ reason: 'Reviewed' })
      .expect(200);
    const after = z.array(ProblemSummary).parse((await content('get', '/problems')).body.data);
    expect(after.filter((p) => p.key === key && p.active).map((p) => p.version)).toEqual([2]);
    await content('post', '/problems')
      .send({ key: 'Bad Key!', content: contentFields, reason: 'x' })
      .expect(400);
  });
});
