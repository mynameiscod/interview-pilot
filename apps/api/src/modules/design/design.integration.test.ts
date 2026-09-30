import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DesignAttemptModel,
  ensureDesignPromptBank,
  ensureLibraryCatalog,
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
  DesignPromptSummary,
  DesignWorkspace,
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
  await ensureDesignPromptBank();
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

/** A READY text interview that opens with a system design round (a prompt and one probe). */
async function designInterview(userId: string) {
  const base = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const [template] = await InterviewTemplateModel.create([
    {
      key: `design-${userId}`,
      version: 1,
      status: 'ACTIVE',
      content: {
        ...base!.content,
        rounds: [
          {
            type: 'SYSTEM_DESIGN',
            durationSec: 1500,
            questionCount: 2,
            difficulty: 'MEDIUM',
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

type Call = Awaited<ReturnType<typeof candidate>>['call'];

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

const design = {
  notes: {
    requirements: '5M links a month, 200M redirects.',
    api: 'POST /links; GET /:code',
    dataModel: 'code -> url in a key-value store',
    scaling: 'Cache hot codes',
    tradeOffs: '302 so opens are counted',
  },
  diagram: {
    nodes: [
      { id: 'n1', label: 'Links API', kind: 'service', x: 20, y: 20 },
      { id: 'n2', label: 'Links DB', kind: 'database', x: 300, y: 20 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'reads' }],
  },
};

describe('system design round', () => {
  it('asks a design prompt, autosaves the whiteboard, then probes the submitted design', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await designInterview(userId);
    const { socket, question } = await startAndJoin(accessToken, call, id);
    expect(question.design).toMatchObject({ title: expect.any(String) });
    expect(question.text).toMatch(/^System design: /);
    const path = `/interviews/${id}/design/${question.questionId}`;

    const ws = DesignWorkspace.parse((await call('get', path).expect(200)).body.data);
    expect(ws).toMatchObject({ submittedAt: null, diagram: { nodes: [], edges: [] } });
    // The rubric stays on the server.
    expect(JSON.stringify(ws)).not.toContain('considerations');

    // The chat box cannot answer a design question.
    const typed = (await socket.timeout(10_000).emitWithAck(RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: question.questionId,
      text: 'My design is a cache.',
      clientMsgId: 'typed-design-0001',
    })) as RtAck;
    expect(typed).toMatchObject({ ok: false, code: 'INVALID_STATE' });

    await call('put', path).send(design).expect(200);
    // Arrows must join existing boxes.
    await call('put', path)
      .send({
        ...design,
        diagram: { ...design.diagram, edges: [{ id: 'x', from: 'n1', to: 'n9', label: '' }] },
      })
      .expect(400);

    const probe = nextQuestion(socket);
    const submitted = DesignWorkspace.parse(
      (await call('post', `${path}/submit`).send(design).expect(200)).body.data,
    );
    expect(submitted.submittedAt).not.toBeNull();
    const turn = (await InterviewTurnModel.findOne({ questionId: question.questionId }).lean())!;
    expect(turn.answer!.text).toContain('Submitted a system design');
    expect(turn.answer!.text).toContain('Links API -> Links DB: reads');

    // The next question probes the design in the same round (the mock model writes it).
    const q2 = await probe;
    expect(q2).toMatchObject({ roundType: 'SYSTEM_DESIGN', design: null, coding: null });
    const joined = (await socket
      .timeout(10_000)
      .emitWithAck(RtEvent.JOIN, { sessionId: id, lastSeq: 0 })) as RtAck;
    expect((joined as { snapshot: InterviewSnapshot }).snapshot.designQuestionId).toBe(
      question.questionId,
    );
    // The design is read-only now; submitting again changes nothing.
    await call('put', path).send(design).expect(409);
    await call('post', `${path}/submit`).send(design).expect(200);
    expect(await DesignAttemptModel.countDocuments({ sessionId: id })).toBe(1);

    const other = await candidate('ravi@example.com');
    await other.call('get', path).expect(404);
  });

  it('lets library admins manage the design bank', async () => {
    const content = await adminAs(['CONTENT_ADMIN']);
    const list = z
      .array(DesignPromptSummary)
      .parse((await content('get', '/design-prompts').expect(200)).body.data);
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.every((p) => p.considerations.length > 0)).toBe(true);
    const base = list.find((p) => p.key === 'short-link-service')!;
    const { id: _id, key, version: _v, active: _a, createdAt: _c, ...fields } = base;
    const created = await content('post', '/design-prompts')
      .send({ key, content: { ...fields, title: 'Short links (v2)' }, reason: 'Clearer title' })
      .expect(201);
    expect(created.body.data).toMatchObject({ version: 2, active: false });
    await content('post', `/design-prompts/${created.body.data.id}/activate`)
      .send({ reason: 'Reviewed' })
      .expect(200);
    const after = z
      .array(DesignPromptSummary)
      .parse((await content('get', '/design-prompts')).body.data);
    expect(after.filter((p) => p.key === key && p.active).map((p) => p.version)).toEqual([2]);
    const support = await adminAs(['SUPPORT_ADMIN']);
    await support('get', '/design-prompts').expect(403);
  });
});
