import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ensureLibraryCatalog,
  FeatureFlagModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  RoleBlueprintModel,
  RoleModel,
} from '@cbi/db';
import { MOCK_SPEECH_PREFIX } from '@cbi/provider-adapters';
import {
  REALTIME_VOICE_FLAG,
  RT_NAMESPACE,
  RtEvent,
  SessionConsents,
  type DeviceCheckBody,
  type InterviewSnapshot,
  type LiveQuestion,
  type QuestionDeltaEvent,
  type QuestionStreamEndEvent,
  type RtAck,
  type VoiceTranscriptEvent,
  type VoiceTurnEndEvent,
} from '@cbi/shared-types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRealtime } from '../../realtime.js';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { bootstrapAi } from '../ai/ai-bootstrap.js';

/**
 * Realtime voice end to end over a real Socket.IO server, MongoDB and Redis
 * with the mock speech providers: a streamed answer is ended by the server,
 * submitted through the ordinary answer path, and the next question arrives
 * as text deltas and sentence audio before it is saved.
 */
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
  await setFlag(true);
  server = createServer(t.app);
  realtime = await createRealtime({ server, container: t.container, redis });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await realtime.close();
});

async function setFlag(enabled: boolean) {
  await FeatureFlagModel.updateOne(
    { key: REALTIME_VOICE_FLAG },
    {
      $set: { enabled, rolloutPercent: 100 },
      $setOnInsert: { description: 'realtime voice', clientVisible: true, updatedBy: null },
    },
    { upsert: true },
  );
  t.container.flags.invalidate();
}

async function candidate(email = 'ravi@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: 'get' | 'post', path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}
type Call = Awaited<ReturnType<typeof candidate>>['call'];

const goodCheck: DeviceCheckBody = {
  microphone: 'PASS',
  recorder: 'PASS',
  speaker: 'PASS',
  network: 'PASS',
  speechService: 'PASS',
  mimeType: 'audio/webm;codecs=opus',
  rttMs: 120,
  browser: 'Chrome 140',
  camera: null,
  videoMimeType: null,
};

/** A started voice interview (device check and consent done). */
async function startedVoiceInterview(
  userId: string,
  call: Call,
  language: 'en' | 'hi' | 'te' = 'en',
) {
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
    mode: 'VOICE',
    language,
  });
  const id = String(session._id);
  await call('post', `/interviews/${id}/device-check`).send(goodCheck).expect(200);
  const consents = SessionConsents.parse(
    (await call('get', `/interviews/${id}/consents`)).body.data,
  );
  await call('post', `/interviews/${id}/consents`)
    .send({
      decisions: consents.items.map((i) => ({ consentTextId: i.text.id, accepted: true })),
    })
    .expect(200);
  await call('post', `/interviews/${id}/start`).expect(200);
  return id;
}

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

async function joinRoom(token: string, sessionId: string) {
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
  const pushed = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION);
  pushed.catch(() => undefined);
  const ack = (await socket
    .timeout(15_000)
    .emitWithAck(RtEvent.JOIN, { sessionId, lastSeq: 0 })) as RtAck;
  if (!ack.ok) throw new Error(`join failed: ${ack.code}`);
  const snapshot = ack.snapshot as InterviewSnapshot;
  return { socket, question: snapshot.currentQuestion ?? (await pushed) };
}

const emit = (socket: Socket, event: string, payload: unknown) =>
  socket.timeout(15_000).emitWithAck(event, payload) as Promise<RtAck>;

/** Streams a scripted phrase, then a second of quiet audio (100 ms PCM frames). */
async function speak(socket: Socket, streamId: string, phrase: string) {
  let seq = 0;
  const frames = [
    Buffer.from(`${MOCK_SPEECH_PREFIX}${phrase}`),
    ...Array.from({ length: 11 }, () => Buffer.alloc(3200)),
  ];
  for (const audio of frames) {
    const ack = await emit(socket, RtEvent.VOICE_STREAM_AUDIO, { streamId, seq: seq++, audio });
    expect(ack.ok).toBe(true);
  }
}

describe('realtime voice (mocked speech providers)', () => {
  it('ends a streamed answer, submits it as the spoken answer and streams the next question', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await startedVoiceInterview(userId, call);
    const { socket, question } = await joinRoom(accessToken, id);

    const started = await emit(socket, RtEvent.VOICE_STREAM_START, {
      sessionId: id,
      questionId: question.questionId,
      encoding: 'linear16',
      sampleRate: 16_000,
    });
    if (!started.ok) throw new Error(`stream refused: ${started.code}`);
    const { streamId } = started.stream!;
    const heard = nextEvent<VoiceTranscriptEvent>(socket, RtEvent.VOICE_TRANSCRIPT);
    const ended = nextEvent<VoiceTurnEndEvent>(socket, RtEvent.VOICE_TURN_END);
    await speak(socket, streamId, 'I designed the ledger service and its idempotency keys');
    expect((await heard).questionId).toBe(question.questionId);
    const turnEnd = await ended;
    expect(turnEnd).toMatchObject({
      reason: 'silence',
      text: 'I designed the ledger service and its idempotency keys',
      graceMs: 2000,
    });

    // After the grace window the room submits it like any spoken answer.
    const deltas: QuestionDeltaEvent[] = [];
    socket.on(RtEvent.QUESTION_DELTA, (d: QuestionDeltaEvent) => deltas.push(d));
    const streamEnd = nextEvent<QuestionStreamEndEvent>(
      socket,
      RtEvent.QUESTION_STREAM_END,
      30_000,
    );
    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION, 30_000);
    const answer = {
      sessionId: id,
      questionId: question.questionId,
      text: turnEnd.text,
      clientMsgId: 'realtime-answer-1',
      voiceTranscriptId: turnEnd.transcriptId,
    };
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toMatchObject({ ok: true });
    // A resend (reconnect) is a no-op.
    expect(await emit(socket, RtEvent.ANSWER_TEXT, answer)).toMatchObject({
      ok: true,
      duplicate: true,
    });
    await emit(socket, RtEvent.VOICE_STREAM_STOP, { streamId, action: 'close' });

    const saved = await InterviewTurnModel.findOne({ questionId: question.questionId }).lean();
    expect(saved!.answer).toMatchObject({
      text: 'I designed the ledger service and its idempotency keys',
      source: 'VOICE',
      voice: { model: 'mock-stt' },
    });

    // The next question streamed before it was saved, and was spoken.
    const second = await next;
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.questionId === second.questionId)).toBe(true);
    expect(deltas.map((d) => d.text).join('')).toBe(second.text);
    expect(await streamEnd).toEqual({ questionId: second.questionId, audio: 'complete' });
  });

  it('keeps a corrected transcript as the answer, marked as edited', async () => {
    const { userId, accessToken, call } = await candidate('meena@example.com');
    const id = await startedVoiceInterview(userId, call);
    const { socket, question } = await joinRoom(accessToken, id);
    const started = await emit(socket, RtEvent.VOICE_STREAM_START, {
      sessionId: id,
      questionId: question.questionId,
      encoding: 'linear16',
      sampleRate: 16_000,
    });
    if (!started.ok) throw new Error('stream refused');
    const { streamId } = started.stream!;
    await emit(socket, RtEvent.VOICE_STREAM_AUDIO, {
      streamId,
      seq: 0,
      audio: Buffer.from(`${MOCK_SPEECH_PREFIX}We used cafe for caching`),
    });
    const ended = nextEvent<VoiceTurnEndEvent>(socket, RtEvent.VOICE_TURN_END);
    await emit(socket, RtEvent.VOICE_STREAM_STOP, { streamId, action: 'send' });
    const turnEnd = await ended;
    expect(turnEnd).toMatchObject({ reason: 'requested', graceMs: 0 });
    await emit(socket, RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: question.questionId,
      text: 'We used Caffeine for caching',
      clientMsgId: 'realtime-edited-1',
      voiceTranscriptId: turnEnd.transcriptId,
      voiceEdited: true,
    });
    const saved = await InterviewTurnModel.findOne({ questionId: question.questionId }).lean();
    expect(saved!.answer).toMatchObject({
      text: 'We used Caffeine for caching',
      source: 'VOICE',
      voice: { edited: true },
    });
  });

  it('sends the room to push-to-talk when realtime voice is off or the language cannot stream', async () => {
    const { userId, accessToken, call } = await candidate('lakshmi@example.com');
    const telugu = await startedVoiceInterview(userId, call, 'te');
    const { socket, question } = await joinRoom(accessToken, telugu);
    const payload = {
      sessionId: telugu,
      questionId: question.questionId,
      encoding: 'linear16',
      sampleRate: 16_000,
    };
    expect(await emit(socket, RtEvent.VOICE_STREAM_START, payload)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    });
    await setFlag(false);
    expect(await emit(socket, RtEvent.VOICE_STREAM_START, payload)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    });
    // Push-to-talk still works as before.
    const flags = (await call('get', '/flags').expect(200)).body.data as Record<string, boolean>;
    expect(flags[REALTIME_VOICE_FLAG]).toBe(false);
  });
});
