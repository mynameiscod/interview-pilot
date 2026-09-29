import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applySessionEvent,
  CreditLedgerModel,
  ensureLibraryCatalog,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  mongoose,
  RoleBlueprintModel,
  RoleModel,
  UserProfileModel,
} from '@cbi/db';
import {
  RT_NAMESPACE,
  RtEvent,
  type InterviewSnapshot,
  type LiveQuestion,
  type RtAck,
} from '@cbi/shared-types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  server = createServer(t.app);
  realtime = await createRealtime({ server, container: t.container, redis });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.disconnect();
  await realtime.close();
});

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: 'get' | 'post', path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}

/** A session that finished analysis (READY), without running the analysis worker. */
async function readyInterview(userId: string, overrides: Record<string, unknown> = {}) {
  const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const target = await JobTargetModel.create({
    userId,
    source: 'ROLE_ONLY',
    roleId: role!._id,
    roleTitle: role!.title,
    extraction: { status: 'READY' },
  });
  const session = await InterviewSessionModel.create({
    userId,
    jobTargetId: target._id,
    templateId: template!._id,
    blueprintId: blueprint!._id,
    state: 'READY',
    ...overrides,
  });
  return String(session._id);
}

function socketFor(token: string): Socket {
  const socket = connect(`${baseUrl}${RT_NAMESPACE}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

const emit = <T extends RtAck>(socket: Socket, event: string, payload: unknown) =>
  socket.timeout(15_000).emitWithAck(event, payload) as Promise<T>;

function nextEvent<T>(socket: Socket, event: string, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${event} within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Questions pushed while a join is in flight (they can arrive before its acknowledgement). */
const pushedDuringJoin = new WeakMap<Socket, Promise<LiveQuestion>>();

async function joined(socket: Socket, sessionId: string, lastSeq = 0) {
  await new Promise<void>((resolve, reject) => {
    if (socket.connected) return resolve();
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  // Listen before joining, as real clients must.
  const pushed = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
  pushed.catch(() => undefined);
  pushedDuringJoin.set(socket, pushed);
  const ack = await emit<RtAck>(socket, RtEvent.JOIN, { sessionId, lastSeq });
  if (!ack.ok) throw new Error(`join failed: ${ack.code}`);
  return ack.snapshot!;
}

/** The question waiting in the snapshot, or the one the server pushes. */
async function currentQuestion(socket: Socket, snapshot: InterviewSnapshot): Promise<LiveQuestion> {
  return snapshot.currentQuestion ?? pushedDuringJoin.get(socket)!;
}

const session = (id: string) => InterviewSessionModel.findById(id).lean();

async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('starting an interview', () => {
  it('reserves the free credit and starts the clock', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    expect((await c.call('get', '/credits/balance').expect(200)).body.data).toMatchObject({
      available: 1,
      reserved: 0,
    });
    const res = await c.call('post', `/interviews/${id}/start`).expect(200);
    expect(res.body.data.state).toBe('ACTIVE');
    expect((await c.call('get', '/credits/balance')).body.data).toMatchObject({
      available: 0,
      reserved: 1,
    });
    const ledger = (await c.call('get', '/credits/ledger').expect(200)).body.data;
    expect(ledger.map((e: { type: string }) => e.type)).toEqual([
      'INTERVIEW_RESERVE',
      'FREE_GRANT',
    ]);
    // A second click is harmless.
    await c.call('post', `/interviews/${id}/start`).expect(200);
    expect(await CreditLedgerModel.countDocuments({ type: 'INTERVIEW_RESERVE' })).toBe(1);
  });

  it('resolves an auto language from the profile, then the UI locale, before English', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).send({ uiLocale: 'te' }).expect(200);
    expect(await session(id)).toMatchObject({ language: 'auto', resolvedLanguage: 'te' });
    const socket = socketFor(c.accessToken);
    const q1 = await currentQuestion(socket, await joined(socket, id));
    expect((await InterviewTurnModel.findOne({ questionId: q1.questionId }).lean())!.language).toBe(
      'te',
    );
    await c.call('post', `/interviews/${id}/end`).expect(200);

    // A profile language wins over the UI locale.
    await UserProfileModel.updateOne(
      { userId: c.userId },
      { $set: { preferredInterviewLanguage: 'hi' } },
      { upsert: true },
    );
    const second = await readyInterview(c.userId);
    await c.call('post', `/interviews/${second}/start`).send({ uiLocale: 'te' }).expect(200);
    expect(await session(second)).toMatchObject({ resolvedLanguage: 'hi' });
    await c.call('post', `/interviews/${second}/start`).send({ uiLocale: 'fr' }).expect(400);
  });

  it('needs a credit and allows one live interview at a time', async () => {
    const c = await candidate();
    const first = await readyInterview(c.userId);
    const second = await readyInterview(c.userId);
    await c.call('post', `/interviews/${first}/start`).expect(200);
    const noCredit = await c.call('post', `/interviews/${second}/start`).expect(402);
    expect(noCredit.body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect((await session(second))!.state).toBe('READY');
  });

  it('refuses sessions that are not ready and other users’ sessions', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const id = await readyInterview(asha.userId, { state: 'DRAFT' });
    await asha.call('post', `/interviews/${id}/start`).expect(409);
    const ready = await readyInterview(asha.userId);
    await ravi.call('post', `/interviews/${ready}/start`).expect(404);
  });
});

describe('realtime room', () => {
  it('rejects sockets without a valid token', async () => {
    const socket = socketFor('not-a-token');
    const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('rejects the token of a session signed out since it was issued', async () => {
    const c = await candidate();
    const ok = socketFor(c.accessToken);
    await new Promise<void>((resolve, reject) => {
      ok.once('connect', () => resolve());
      ok.once('connect_error', reject);
    });
    // The device signs itself out (its session id is the one in the token).
    const [current] = (
      await request(t.app)
        .get('/api/v1/auth/sessions')
        .set('Authorization', `Bearer ${c.accessToken}`)
        .expect(200)
    ).body.data;
    await request(t.app)
      .delete(`/api/v1/auth/sessions/${current.id}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${c.accessToken}`)
      .expect(204);
    const socket = socketFor(c.accessToken);
    const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('asks questions, records answers once and moves on', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const snapshot = await joined(socket, id);
    expect(snapshot).toMatchObject({ sessionId: id, state: 'ACTIVE', roundIdx: 0 });
    expect(snapshot.rounds.map((r) => r.type)).toEqual([
      'INTRO',
      'TECHNICAL',
      'PROBLEM_SOLVING',
      'BEHAVIORAL',
      'WRAP_UP',
    ]);
    const q1 = await currentQuestion(socket, snapshot);
    expect(q1).toMatchObject({ seq: 1, roundType: 'INTRO', isFollowUp: false });
    // The clock runs once the question is on screen.
    expect((await session(id))!.clock).toMatchObject({
      held: false,
      runningSince: expect.any(Date),
    });

    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    const answer = {
      sessionId: id,
      questionId: q1.questionId,
      text: 'I build payment APIs in Node.js.',
      clientMsgId: 'msg-00000001',
    };
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toEqual({ ok: true, duplicate: false });
    const q2 = await next;
    // The standard template's intro round asks two questions.
    expect(q2).toMatchObject({ seq: 2, roundType: 'INTRO' });
    // The same message again (a client retry) is acknowledged without a second answer.
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toEqual({ ok: true, duplicate: true });
    // A different answer to an answered question is refused.
    expect(
      await emit(socket, RtEvent.ANSWER_TEXT, { ...answer, clientMsgId: 'msg-00000002' }),
    ).toMatchObject({
      ok: false,
      code: 'STALE_QUESTION',
    });

    const turn = await InterviewTurnModel.findOne({ questionId: q1.questionId }).lean();
    expect(turn!.answer).toMatchObject({ text: answer.text, clientMsgId: 'msg-00000001' });
    expect(turn!.turnEval).toMatchObject({ fallback: false });
    expect(turn!.question).toMatchObject({ source: 'ROLE', promptVersion: 1 });
    // Assessments stay internal: nothing about them reaches the candidate.
    const live = (await c.call('get', `/interviews/${id}/live`).expect(200)).body.data;
    expect(JSON.stringify(live)).not.toMatch(/sufficiency|turnEval|evidence/);
  });

  it('acknowledges a saved answer at once and holds the clock until the next question', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const q1 = await currentQuestion(socket, await joined(socket, id));
    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    const answer = {
      sessionId: id,
      questionId: q1.questionId,
      text: 'I build payment APIs in Node.js.',
      clientMsgId: 'msg-00000001',
    };
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toEqual({ ok: true, duplicate: false });
    // Saved when acknowledged; a resend while the next question is prepared is not "busy".
    const saved = (await InterviewTurnModel.findOne({ questionId: q1.questionId }).lean())!;
    expect(saved.answer).toMatchObject({ clientMsgId: 'msg-00000001' });
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toEqual({ ok: true, duplicate: true });

    const q2 = await next;
    const s = (await session(id))!;
    // The time spent assessing and preparing q2 was not counted: the clock restarted
    // after the answer, and the time used is at most what had passed when it arrived.
    expect(s.clock!.held).toBe(false);
    expect(s.clock!.runningSince!.getTime()).toBeGreaterThanOrEqual(
      saved.answer!.answeredAt.getTime(),
    );
    expect(s.clock!.activeMs).toBeLessThanOrEqual(
      saved.answer!.answeredAt.getTime() - s.startedAt!.getTime(),
    );
    const turn2 = (await InterviewTurnModel.findOne({ questionId: q2.questionId }).lean())!;
    expect(s.clock!.runningSince!.getTime()).toBeLessThanOrEqual(turn2.askedAt.getTime() + 1000);
  });

  it('records an answer it could not assess as unassessed and keeps going', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const q1 = await currentQuestion(socket, await joined(socket, id));
    // The assessment prompt is unavailable (the model call cannot run).
    const prompts = t.container.ai.prompts;
    const getActive = prompts.getActive.bind(prompts);
    vi.spyOn(prompts, 'getActive').mockImplementation((...args: Parameters<typeof getActive>) =>
      args[0] === 'interview.assessTurn' ? Promise.resolve(null) : getActive(...args),
    );
    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    expect(
      await emit(socket, RtEvent.ANSWER_TEXT, {
        sessionId: id,
        questionId: q1.questionId,
        text: 'I build payment APIs in Node.js.',
        clientMsgId: 'msg-00000001',
      }),
    ).toEqual({ ok: true, duplicate: false });
    expect((await next).seq).toBe(2);
    const turn = (await InterviewTurnModel.findOne({ questionId: q1.questionId }).lean())!;
    // No verdict is invented: not ADEQUATE, but explicitly unassessed.
    expect(turn.turnEval).toMatchObject({
      sufficiency: 'UNASSESSED',
      fallback: true,
      evidence: [],
    });
    expect((await session(id))!.planner!.answeredCount).toBe(1);
  });

  it('accepts an answer from the owner while reconnecting and resumes the interview', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const q1 = await currentQuestion(socket, await joined(socket, id));
    // The server decided the connection was lost (missed heartbeats) though the socket lives on.
    const current = (await session(id))!;
    expect(
      await applySessionEvent({
        sessionId: id,
        event: { type: 'DISCONNECTED' },
        expectedVersion: current.stateVersion,
      }),
    ).toMatchObject({ ok: true, session: { state: 'RECONNECTING' } });

    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    expect(
      await emit(socket, RtEvent.ANSWER_TEXT, {
        sessionId: id,
        questionId: q1.questionId,
        text: 'Answered while the server thought I was away.',
        clientMsgId: 'msg-00000001',
      }),
    ).toEqual({ ok: true, duplicate: false });
    expect((await next).seq).toBe(2);
    const s = (await session(id))!;
    expect(s.state).toBe('ACTIVE');
    expect(s.stateHistory.map((h) => h.to).slice(-2)).toEqual(['RECONNECTING', 'ACTIVE']);
  });

  it('keeps other candidates out of the room', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const id = await readyInterview(asha.userId);
    await asha.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(ravi.accessToken);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    const overheard: unknown[] = [];
    socket.onAny((event: string) => overheard.push(event));
    expect(await emit(socket, RtEvent.JOIN, { sessionId: id, lastSeq: 0 })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    // The refused socket never joined the room, not even briefly.
    const own = socketFor(asha.accessToken);
    await currentQuestion(own, await joined(own, id));
    expect(overheard).toEqual([]);
    expect(
      await emit(socket, RtEvent.ANSWER_TEXT, {
        sessionId: id,
        questionId: 'x',
        text: 'hi',
        clientMsgId: 'msg-00000009',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});

describe('reconnect and resume (end to end)', () => {
  it('pauses the clock on disconnect and continues where the candidate left off', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    let socket = socketFor(c.accessToken);
    const first = await joined(socket, id);
    const q1 = await currentQuestion(socket, first);
    const pushed = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    await emit(socket, RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: q1.questionId,
      text: 'Answer one',
      clientMsgId: 'msg-00000001',
    });
    const q2 = await pushed;

    // The connection drops: the session waits in RECONNECTING with the clock stopped.
    socket.disconnect();
    const dropped = await until(async () => {
      const s = await session(id);
      return s?.state === 'RECONNECTING' ? s : null;
    });
    expect(dropped.clock!.runningSince).toBeNull();
    const usedAtDrop = dropped.clock!.activeMs;
    await new Promise((r) => setTimeout(r, 300));

    // The candidate comes back with what they already have (lastSeq 1).
    socket = socketFor(c.accessToken);
    const resumed = await joined(socket, id, 1);
    expect(resumed.state).toBe('ACTIVE');
    expect(resumed.currentQuestion).toMatchObject({ questionId: q2.questionId, seq: 2 });
    expect(resumed.turns.map((x) => x.seq)).toEqual([2]);
    const after = await session(id);
    expect(after!.clock!.activeMs).toBe(usedAtDrop); // disconnected time was not counted
    expect(after!.stateHistory.map((h) => h.to).slice(-2)).toEqual(['RECONNECTING', 'ACTIVE']);

    // Answering continues the same interview.
    const q3 = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
    expect(
      await emit(socket, RtEvent.ANSWER_TEXT, {
        sessionId: id,
        questionId: q2.questionId,
        text: 'Answer two',
        clientMsgId: 'msg-00000002',
      }),
    ).toMatchObject({ ok: true });
    expect((await q3).seq).toBe(3);
  });

  it('resumes a paused interview after the grace period', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const snapshot = await joined(socket, id);
    const q1 = await currentQuestion(socket, snapshot);
    socket.disconnect();
    await until(async () => (await session(id))?.state === 'RECONNECTING');
    // What the worker sweep does once the reconnect grace period has passed.
    expect(
      await applySessionEvent({ sessionId: id, event: { type: 'GRACE_EXPIRED' } }),
    ).toMatchObject({
      ok: true,
      session: { state: 'PAUSED' },
    });
    const back = socketFor(c.accessToken);
    const resumed = await joined(back, id, 0);
    expect(resumed).toMatchObject({
      state: 'ACTIVE',
      currentQuestion: { questionId: q1.questionId },
    });
    expect(resumed.turns).toHaveLength(1);
  });

  it('lets the candidate end early and refunds an interview that was barely used', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    await joined(socket, id);
    const completed = nextEvent<InterviewSnapshot>(socket, RtEvent.COMPLETED);
    const res = await c.call('post', `/interviews/${id}/end`).expect(200);
    expect(res.body.data.state).toBe('PROCESSING');
    expect(t.jobs.jobs).toContainEqual({ kind: 'evaluate', id, rerun: false });
    expect((await completed).state).toBe('PROCESSING');
    const s = await session(id);
    expect(s).toMatchObject({
      live: false,
      credit: { status: 'REFUNDED' },
      endReason: 'END_REQUESTED',
    });
    expect((await c.call('get', '/credits/balance')).body.data).toMatchObject({
      available: 1,
      reserved: 0,
    });
    await c.call('post', `/interviews/${id}/end`).expect(200);
  });
});

describe('a full text interview', () => {
  it('runs every round to completion and consumes the credit', async () => {
    const c = await candidate();
    const id = await readyInterview(c.userId);
    await c.call('post', `/interviews/${id}/start`).expect(200);
    const socket = socketFor(c.accessToken);
    const transitions: number[] = [];
    socket.on(RtEvent.ROUND_TRANSITION, (e: { toRoundIdx: number }) =>
      transitions.push(e.toRoundIdx),
    );
    const completed = nextEvent<InterviewSnapshot>(socket, RtEvent.COMPLETED, 60_000);
    let question = await currentQuestion(socket, await joined(socket, id));
    for (let i = 1; i <= 40; i++) {
      const next = Promise.race([
        nextEvent<LiveQuestion>(socket, RtEvent.QUESTION),
        completed.then(() => null),
      ]);
      const ack = await emit(socket, RtEvent.ANSWER_TEXT, {
        sessionId: id,
        questionId: question.questionId,
        text: `A detailed answer number ${i} with a concrete example and the result.`,
        clientMsgId: `msg-${String(i).padStart(8, '0')}`,
      });
      expect(ack).toMatchObject({ ok: true });
      const q = await next;
      if (!q) break;
      question = q;
    }
    const final = await completed;
    expect(final.state).toBe('PROCESSING');
    expect(transitions).toEqual([1, 2, 3, 4]);
    const s = await session(id);
    expect(s!.planner!.rounds.map((r) => r.state)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
    ]);
    // The standard template asks 2 + 4 + 2 + 2 + 1 = 11 primary questions (the mock never asks for follow-ups).
    expect(
      await InterviewTurnModel.countDocuments({ sessionId: new mongoose.Types.ObjectId(id) }),
    ).toBe(11);
    expect(s).toMatchObject({ credit: { status: 'CONSUMED' }, live: false });
    expect((await c.call('get', '/credits/balance')).body.data).toMatchObject({
      available: 0,
      reserved: 0,
    });
  }, 90_000);
});
