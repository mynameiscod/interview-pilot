import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AiRouteModel,
  AiUsageModel,
  AuditLogModel,
  ensureLibraryCatalog,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  JobTargetModel,
  RoleBlueprintModel,
  RoleModel,
} from '@cbi/db';
import { mockSpeech, mockSpeechFailure } from '@cbi/provider-adapters';
import {
  InterviewSummary,
  RT_NAMESPACE,
  RtEvent,
  VOICE_CONSENT_VERSION,
  VoiceReadiness,
  VoiceTranscript,
  type DegradedEvent,
  type DeviceCheckBody,
  type InterviewSnapshot,
  type LiveQuestion,
  type ModeChangedEvent,
  type RtAck,
} from '@cbi/shared-types';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  for (const s of sockets.splice(0)) s.disconnect();
  await realtime.close();
});

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: 'get' | 'post' | 'patch', path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}

type Call = Awaited<ReturnType<typeof candidate>>['call'];

/** A session that finished analysis (READY) in voice mode. */
async function readyInterview(userId: string, mode: 'VOICE' | 'TEXT' = 'VOICE') {
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
    mode,
  });
  return String(session._id);
}

const goodCheck: DeviceCheckBody = {
  microphone: 'PASS',
  recorder: 'PASS',
  speaker: 'PASS',
  network: 'WARN',
  speechService: 'PASS',
  mimeType: 'audio/webm;codecs=opus',
  rttMs: 240,
  browser: 'Chrome 140',
};

async function prepareVoice(call: Call, id: string) {
  await call('post', `/interviews/${id}/device-check`).send(goodCheck).expect(200);
  const consent = await call('post', `/interviews/${id}/voice-consent`)
    .send({ accepted: true, version: VOICE_CONSENT_VERSION })
    .expect(200);
  return VoiceReadiness.parse(consent.body.data);
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

/** Connects, joins and returns the first question (from the snapshot or the push). */
async function joinRoom(token: string, sessionId: string) {
  const socket = socketFor(token);
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
  const question = snapshot.currentQuestion ?? (await pushed);
  return { socket, snapshot, question };
}

function transcribe(
  call: Call,
  id: string,
  questionId: string,
  audio: Uint8Array,
  durationMs = 4200,
) {
  return call('post', `/interviews/${id}/voice/transcribe`)
    .field('questionId', questionId)
    .field('durationMs', String(durationMs))
    .attach('audio', Buffer.from(audio), { filename: 'answer.wav', contentType: 'audio/wav' });
}

describe('voice readiness', () => {
  it('needs a passing device check and consent before a voice interview starts', async () => {
    const { userId, call } = await candidate();
    const id = await readyInterview(userId);
    const blocked = await call('post', `/interviews/${id}/start`).expect(409);
    expect(blocked.body.error.message).toMatch(/device check/i);

    const failed = await call('post', `/interviews/${id}/device-check`)
      .send({ ...goodCheck, microphone: 'FAIL' })
      .expect(200);
    expect(failed.body.data).toMatchObject({ ready: false, deviceCheck: { passed: false } });
    await call('post', `/interviews/${id}/start`).expect(409);

    await call('post', `/interviews/${id}/device-check`).send(goodCheck).expect(200);
    const noConsent = await call('post', `/interviews/${id}/start`).expect(409);
    expect(noConsent.body.error.message).toMatch(/voice processing notice/i);
    await call('post', `/interviews/${id}/voice-consent`)
      .send({ accepted: true, version: 'old-version' })
      .expect(400);
    const readiness = await prepareVoice(call, id);
    expect(readiness.ready).toBe(true);

    const summary = InterviewSummary.parse((await call('get', `/interviews/${id}`)).body.data);
    expect(summary.voice).toMatchObject({ ready: true, deviceCheck: { network: 'WARN' } });

    const started = await call('post', `/interviews/${id}/start`).expect(200);
    expect(started.body.data.state).toBe('ACTIVE');
    const session = (await InterviewSessionModel.findById(id).lean())!;
    expect(session.stateHistory.map((h) => h.to)).toEqual([
      'DEVICE_CHECK',
      'CONSENT_REQUIRED',
      'READY_TO_START',
      'ACTIVE',
    ]);
    expect(await AuditLogModel.countDocuments({ action: 'interview.voice_consent' })).toBe(1);
    // Voice set-up is refused once the interview is running, and for text interviews.
    await call('post', `/interviews/${id}/device-check`).send(goodCheck).expect(409);
    const text = await readyInterview(userId, 'TEXT');
    await call('post', `/interviews/${text}/device-check`).send(goodCheck).expect(409);
  });

  it('reports speech service status for the device check', async () => {
    const { call } = await candidate();
    // Test environment: no provider keys, so only the mock (last in each chain) can serve.
    const res = await call('get', '/voice/health').expect(200);
    expect(res.body.data).toEqual({ stt: 'DEGRADED', tts: 'DEGRADED' });
  });
});

describe('voice interview (mocked speech providers)', () => {
  it('speaks questions, transcribes spoken answers and uses the server transcript as the answer', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId);
    await prepareVoice(call, id);
    await call('post', `/interviews/${id}/start`).expect(200);
    const { socket, snapshot, question } = await joinRoom(accessToken, id);
    expect(snapshot).toMatchObject({ mode: 'VOICE', voiceEnabled: true });

    // The spoken question: synthesized once (warmed when asked), then served from the cache.
    const audio = await call('get', `/interviews/${id}/questions/${question.questionId}/audio`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect((audio.body as Buffer).subarray(0, 4).toString('latin1')).toBe('RIFF');
    await call('get', `/interviews/${id}/questions/${question.questionId}/audio`).expect(200);
    expect(await AiUsageModel.countDocuments({ feature: 'tts.live', outcome: 'SUCCESS' })).toBe(1);

    // Record → transcript for review.
    const spoken = 'I designed the order service and cut p99 latency from 800 to 120 milliseconds.';
    const res = await transcribe(call, id, question.questionId, mockSpeech(spoken)).expect(200);
    const transcript = VoiceTranscript.parse(res.body.data);
    expect(transcript).toMatchObject({ text: spoken, lowConfidence: false, durationSec: 4.2 });
    const unclear = VoiceTranscript.parse(
      (await transcribe(call, id, question.questionId, mockSpeech('um [unclear]')).expect(200)).body
        .data,
    );
    expect(unclear.lowConfidence).toBe(true);
    // Not an audio container.
    await transcribe(call, id, question.questionId, new TextEncoder().encode('hello')).expect(415);
    await transcribe(call, id, question.questionId, mockSpeech('x'), 100).expect(400);

    // Another candidate cannot transcribe into this interview.
    const other = await candidate('ravi@example.com');
    await transcribe(other.call, id, question.questionId, mockSpeech('x')).expect(404);

    // Submit: the client text is ignored in favour of the stored transcript.
    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION, 30_000);
    const ack = (await socket.timeout(30_000).emitWithAck(RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: question.questionId,
      text: 'something else entirely',
      clientMsgId: 'voice-answer-0001',
      voiceTranscriptId: transcript.transcriptId,
    })) as RtAck;
    expect(ack.ok).toBe(true);
    const turn = (await InterviewTurnModel.findOne({ questionId: question.questionId }).lean())!;
    expect(turn.answer).toMatchObject({
      text: spoken,
      source: 'VOICE',
      voice: { durationSec: 4.2, model: 'mock-stt', confidence: 0.99 },
    });
    const second = await next;
    expect(second.seq).toBe(question.seq + 1);
    expect(
      await AiUsageModel.countDocuments({ feature: 'stt.live', outcome: 'SUCCESS' }),
    ).toBeGreaterThanOrEqual(2);

    // A transcript belongs to its question.
    const stale = (await socket.timeout(15_000).emitWithAck(RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: second.questionId,
      text: '',
      clientMsgId: 'voice-answer-0002',
      voiceTranscriptId: unclear.transcriptId,
    })) as RtAck;
    expect(stale).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    // The previous question can no longer be answered by voice.
    await transcribe(call, id, question.questionId, mockSpeech('late')).expect(409);

    const rejoin = await joinRoom(accessToken, id);
    expect(rejoin.snapshot.turns[0]).toMatchObject({ answer: spoken, answerSource: 'VOICE' });
  });

  it('degrades to text when speech recognition fails, and can switch back', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId);
    await prepareVoice(call, id);
    await call('post', `/interviews/${id}/start`).expect(200);
    const { socket, question } = await joinRoom(accessToken, id);

    const degraded = nextEvent<DegradedEvent>(socket, RtEvent.DEGRADED);
    const failed = await transcribe(call, id, question.questionId, mockSpeechFailure()).expect(503);
    expect(failed.body.error.code).toBe('SPEECH_UNAVAILABLE');
    expect(await degraded).toEqual({ kind: 'STT', options: ['RETRY', 'SWITCH_TO_TEXT'] });

    const changed = nextEvent<ModeChangedEvent>(socket, RtEvent.MODE_CHANGED);
    await call('post', `/interviews/${id}/mode`)
      .send({ mode: 'TEXT', reason: 'STT_UNAVAILABLE' })
      .expect(200);
    expect(await changed).toEqual({ mode: 'TEXT', reason: 'STT_UNAVAILABLE' });
    // Text mode: typed answers work, recording is refused, state and clock are untouched.
    await transcribe(call, id, question.questionId, mockSpeech('x')).expect(409);
    const next = nextEvent<LiveQuestion>(socket, RtEvent.QUESTION, 30_000);
    const ack = (await socket.timeout(30_000).emitWithAck(RtEvent.ANSWER_TEXT, {
      sessionId: id,
      questionId: question.questionId,
      text: 'I built the payment reconciliation job and its alerting.',
      clientMsgId: 'typed-answer-0001',
    })) as RtAck;
    expect(ack.ok).toBe(true);
    await next;
    const session = (await InterviewSessionModel.findById(id).lean())!;
    expect(session).toMatchObject({ state: 'ACTIVE', mode: 'TEXT' });
    expect(session.voice!.modeHistory).toMatchObject([{ mode: 'TEXT', reason: 'STT_UNAVAILABLE' }]);
    expect(
      (await InterviewTurnModel.findOne({ questionId: question.questionId }).lean())!.answer!
        .source,
    ).toBe('TEXT');

    // Back to voice once the candidate chooses.
    await call('post', `/interviews/${id}/mode`)
      .send({ mode: 'VOICE', reason: 'CANDIDATE_CHOICE' })
      .expect(200);
    expect((await InterviewSessionModel.findById(id).lean())!.mode).toBe('VOICE');
    expect(await AuditLogModel.countDocuments({ action: 'interview.mode_switched' })).toBe(2);
  });

  it('keeps the interview going when spoken questions are unavailable', async () => {
    const { userId, accessToken, call } = await candidate();
    const id = await readyInterview(userId);
    await prepareVoice(call, id);
    await AiRouteModel.updateOne({ feature: 'tts.live' }, { $set: { active: false } });
    t.container.ai.invalidateLocal();
    await call('post', `/interviews/${id}/start`).expect(200);
    const { socket, question } = await joinRoom(accessToken, id);
    const degraded = nextEvent<DegradedEvent>(socket, RtEvent.DEGRADED);
    const res = await call(
      'get',
      `/interviews/${id}/questions/${question.questionId}/audio`,
    ).expect(503);
    expect(res.body.error.code).toBe('SPEECH_UNAVAILABLE');
    expect(await degraded).toMatchObject({ kind: 'TTS' });
    // The question text is still there and a spoken answer still works.
    await transcribe(call, id, question.questionId, mockSpeech('Still answering.')).expect(200);
    // A text interview that was never set up for voice cannot switch to it.
    const text = await readyInterview(userId, 'TEXT');
    await call('post', `/interviews/${text}/mode`)
      .send({ mode: 'VOICE', reason: 'CANDIDATE_CHOICE' })
      .expect(409);
  });
});
