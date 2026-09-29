import { randomUUID } from 'node:crypto';
import { AiAbortedError, AiUnavailableError } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import {
  InterviewSessionModel,
  InterviewTurnModel,
  type InterviewSessionRecord,
  type InterviewTurnRecord,
  type Redis,
} from '@cbi/db';
import {
  deviceCheckPassed,
  isSpokenMode,
  REALTIME_VOICE_FLAG,
  realtimeSttSupported,
  RtEvent,
  VOICE_LIMITS,
  type InterviewLanguage,
  type KnownFlag,
  type VoiceStreamStartPayload,
  type DegradedEvent,
  type DeviceCheckBody,
  type ModeChangedEvent,
  type SwitchModeBody,
  type TranscribeFields,
  type VoiceHealth,
  type VoiceTranscript,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { objectId } from '../../lib/ids.js';
import { releaseLock } from '../../lib/lock.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { ConsentService } from '../consent/consent.service.js';
import { LiveError, questionLanguage, type RoomEmitter } from '../live/live.service.js';
import { billableDurationSec } from './audio-duration.js';

type Session = InterviewSessionRecord;

// ---- Audio sniffing --------------------------------------------------------------------------

/** Detects the container from magic bytes; the declared type is not trusted. */
export function sniffAudio(
  bytes: Uint8Array,
): (typeof MIME_BY_KIND)[keyof typeof MIME_BY_KIND] | null {
  const ascii = (from: number, len: number) =>
    String.fromCharCode(...bytes.subarray(from, from + len));
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return MIME_BY_KIND.webm;
  if (ascii(0, 4) === 'OggS') return MIME_BY_KIND.ogg;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return MIME_BY_KIND.wav;
  if (ascii(4, 4) === 'ftyp') return MIME_BY_KIND.mp4;
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return MIME_BY_KIND.mpeg;
  return null;
}
const MIME_BY_KIND = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
} as const;

// ---- Transcript store ------------------------------------------------------------------------

export interface StoredTranscript {
  transcriptId: string;
  userId: string;
  sessionId: string;
  questionId: string;
  text: string;
  durationSec: number;
  language: string | null;
  confidence: number | null;
  model: string;
}

/**
 * Transcripts wait in Redis until the candidate submits them as their answer
 * (the answer text then comes from here, not from the client).
 */
export function createTranscriptStore(redis: Redis) {
  const key = (id: string) => `cbi:voice:transcript:${id}`;
  return {
    async put(t: StoredTranscript) {
      await redis.set(key(t.transcriptId), JSON.stringify(t), 'EX', VOICE_LIMITS.transcriptTtlSec);
    },
    async get(id: string): Promise<StoredTranscript | null> {
      const raw = await redis.get(key(id));
      return raw ? (JSON.parse(raw) as StoredTranscript) : null;
    },
  };
}
export type TranscriptStore = ReturnType<typeof createTranscriptStore>;

// ---- Question audio cache --------------------------------------------------------------------

export interface QuestionAudio {
  audio: Buffer;
  mimeType: string;
}

const AUDIO_TTL_SEC = 2 * 3600;

/**
 * Spoken questions, cached in Redis and synthesized once across every API
 * replica. The first replica to ask takes a short Redis lock and
 * synthesizes; the others wait for its cache write and read it. If the
 * holder fails (or is slower than the lock), a waiter synthesizes itself.
 * When Redis is unavailable each replica synthesizes on its own (as before).
 */
export function createQuestionAudioCache(opts: {
  redis: Redis;
  logger: Logger;
  /** Lock lifetime: also how long a waiter waits before synthesizing itself. */
  lockMs?: number;
  pollMs?: number;
}) {
  const { redis, logger } = opts;
  const lockMs = opts.lockMs ?? 20_000;
  const pollMs = opts.pollMs ?? 150;
  const key = (questionId: string) => `cbi:voice:tts:${questionId}`;
  const lockKey = (questionId: string) => `cbi:voice:tts-lock:${questionId}`;

  async function read(questionId: string): Promise<QuestionAudio | null> {
    const [audio, mimeType] = await Promise.all([
      redis.getBuffer(key(questionId)),
      redis.get(`${key(questionId)}:type`),
    ]).catch(() => [null, null] as const);
    return audio && mimeType ? { audio, mimeType } : null;
  }

  async function produce(questionId: string, synthesize: () => Promise<QuestionAudio>) {
    const result = await synthesize();
    await redis
      .multi()
      .set(key(questionId), result.audio, 'EX', AUDIO_TTL_SEC)
      .set(`${key(questionId)}:type`, result.mimeType, 'EX', AUDIO_TTL_SEC)
      .exec()
      .catch((err: unknown) => logger.warn({ err }, 'question audio cache write failed'));
    return result;
  }

  return {
    read,
    /** Stores audio produced elsewhere (a question spoken while it was streamed). */
    async put(questionId: string, audio: QuestionAudio) {
      await redis
        .multi()
        .set(key(questionId), audio.audio, 'EX', AUDIO_TTL_SEC)
        .set(`${key(questionId)}:type`, audio.mimeType, 'EX', AUDIO_TTL_SEC)
        .exec();
    },
    async get(
      questionId: string,
      synthesize: () => Promise<QuestionAudio>,
    ): Promise<QuestionAudio> {
      const cached = await read(questionId);
      if (cached) return cached;
      const token = randomUUID();
      const acquired = await redis
        .set(lockKey(questionId), token, 'PX', lockMs, 'NX')
        .catch(() => 'NO_REDIS' as const);
      if (acquired === 'OK' || acquired === 'NO_REDIS') {
        try {
          // Another replica may have finished between the read and the lock.
          return (await read(questionId)) ?? (await produce(questionId, synthesize));
        } finally {
          if (acquired === 'OK') await releaseLock(redis, lockKey(questionId), token);
        }
      }
      // Another replica is synthesizing this question: wait for its cache write.
      const deadline = Date.now() + lockMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const ready = await read(questionId);
        if (ready) return ready;
        const held = await redis.exists(lockKey(questionId)).catch(() => 0);
        if (!held) break;
      }
      // The holder failed (its lock is gone without a result) or is too slow.
      return (await read(questionId)) ?? produce(questionId, synthesize);
    },
  };
}
export type QuestionAudioCache = ReturnType<typeof createQuestionAudioCache>;

// ---- Service -----------------------------------------------------------------------------------

const LIVE = new Set(['ACTIVE', 'ROUND_TRANSITION']);
const SWITCHABLE = new Set(['ACTIVE', 'ROUND_TRANSITION', 'RECONNECTING', 'PAUSED']);
const PRE_START = new Set(['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START']);
const LOW_CONFIDENCE = 0.5;

const speechUnavailable = (what: string) =>
  new AppError(503, 'SPEECH_UNAVAILABLE', `${what} unavailable right now.`);

interface Deps {
  ai: AiRuntime;
  redis: Redis;
  logger: Logger;
  rooms: RoomEmitter;
  audit: AuditService;
  transcripts: TranscriptStore;
  consent: ConsentService;
  /** Defaults to one on `redis` (tests shorten its timings). */
  questionAudio?: QuestionAudioCache;
  /** Feature flags (realtime voice); without it realtime voice is off. */
  flags?: { isEnabled(key: KnownFlag, userId: string | null): Promise<boolean> };
  now?: () => Date;
}

export function createVoiceService(deps: Deps) {
  const { ai, redis, logger, rooms, audit, transcripts, consent } = deps;
  const now = deps.now ?? (() => new Date());
  const audioCache = deps.questionAudio ?? createQuestionAudioCache({ redis, logger });
  /** One synthesis per question per process; the cache's Redis lock covers other replicas. */
  const inFlight = new Map<string, Promise<QuestionAudio>>();

  async function own(userId: string, sessionId: string): Promise<Session> {
    const s = await InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      userId,
    }).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    return s;
  }

  const language = (s: Session) => (s.language === 'auto' ? null : s.language);

  function degraded(sessionId: string, event: DegradedEvent) {
    rooms.emit(sessionId, RtEvent.DEGRADED, event);
  }

  async function synthesize(
    s: Session,
    turn: Pick<InterviewTurnRecord, 'questionId' | 'question'>,
  ) {
    let pending = inFlight.get(turn.questionId);
    if (!pending) {
      pending = audioCache
        .get(turn.questionId, async () => {
          const r = await ai.router.synthesize(
            { text: turn.question.text, language: language(s) },
            { userId: String(s.userId), sessionId: String(s._id) },
          );
          return { audio: Buffer.from(r.result.audio), mimeType: r.result.mimeType };
        })
        .finally(() => inFlight.delete(turn.questionId));
      inFlight.set(turn.questionId, pending);
    }
    return pending;
  }

  /**
   * Realtime voice is on for this interview: a spoken mode and the
   * `voice.realtime` flag for the candidate (stable rollout per user).
   */
  async function realtimeEnabled(s: Pick<Session, 'mode' | 'userId'>): Promise<boolean> {
    if (!isSpokenMode(s.mode) || !deps.flags) return false;
    return deps.flags.isEnabled(REALTIME_VOICE_FLAG, String(s.userId)).catch(() => false);
  }

  return {
    async health(): Promise<VoiceHealth> {
      const [stt, tts] = await Promise.all([
        ai.router.routeStatus('stt.live'),
        ai.router.routeStatus('tts.live'),
      ]);
      return { stt, tts };
    },

    /** Records the browser's device check (before starting; the session stays READY). */
    async recordDeviceCheck(userId: string, sessionId: string, body: DeviceCheckBody) {
      const s = await own(userId, sessionId);
      if (!PRE_START.has(s.state))
        throw new AppError(
          409,
          'INVALID_STATE',
          'The device check is done before the interview starts.',
        );
      if (!isSpokenMode(s.mode))
        throw new AppError(409, 'INVALID_STATE', 'Choose a voice or video interview first.');
      const deviceCheck = { ...body, at: now(), passed: deviceCheckPassed(body, s.mode) };
      const updated = await InterviewSessionModel.findOneAndUpdate(
        { _id: s._id, userId },
        s.voice
          ? { $set: { 'voice.deviceCheck': deviceCheck, 'voice.spokenMode': s.mode } }
          : { $set: { voice: { deviceCheck, spokenMode: s.mode, modeHistory: [] } } },
        { returnDocument: 'after' },
      ).lean<Session>();
      return (await consent.readiness(updated!, now())).voice!;
    },

    /**
     * Transcribes a recorded answer to the current question. The transcript is
     * returned for review and kept server-side; submitting it as the answer
     * uses the stored text.
     */
    async transcribe(
      userId: string,
      sessionId: string,
      fields: TranscribeFields,
      audio: Buffer,
    ): Promise<VoiceTranscript> {
      const s = await own(userId, sessionId);
      if (!LIVE.has(s.state))
        throw new AppError(409, 'INVALID_STATE', 'The interview is not active.');
      if (!isSpokenMode(s.mode))
        throw new AppError(409, 'INVALID_STATE', 'This interview is in text mode.');
      const turn = await InterviewTurnModel.findOne({
        sessionId: s._id,
        questionId: fields.questionId,
      }).lean();
      if (!turn || turn.seq !== s.lastSeq || turn.answer) {
        throw new AppError(409, 'INVALID_STATE', 'This is not the current question.');
      }
      if (fields.durationMs < VOICE_LIMITS.minAnswerMs) {
        throw AppError.validation('The recording is too short. Please answer again.');
      }
      const mimeType = sniffAudio(audio);
      if (!mimeType) {
        throw new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'This recording format is not supported.',
        );
      }
      // Usage and cost follow the audio itself, not the browser's figure (some models report none).
      const durationSec = billableDurationSec(audio, mimeType, fields.durationMs);
      let result;
      try {
        result = await ai.router.transcribe(
          {
            audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
            mimeType,
            language: language(s),
            durationSec,
          },
          { userId, sessionId },
        );
      } catch (err) {
        if (err instanceof AiUnavailableError || err instanceof AiAbortedError) {
          degraded(sessionId, { kind: 'STT', options: ['RETRY', 'SWITCH_TO_TEXT'] });
          throw speechUnavailable('Speech recognition is');
        }
        throw err;
      }
      const stored: StoredTranscript = {
        transcriptId: randomUUID(),
        userId,
        sessionId,
        questionId: fields.questionId,
        text: result.result.text.slice(0, 6000),
        durationSec: result.usage.audioSec ?? durationSec,
        language: result.result.language,
        confidence: result.result.confidence,
        model: result.model.modelId,
      };
      await transcripts.put(stored);
      return {
        transcriptId: stored.transcriptId,
        questionId: stored.questionId,
        text: stored.text,
        durationSec: Math.round(stored.durationSec * 10) / 10,
        language: stored.language,
        lowConfidence:
          stored.text.trim().length === 0 ||
          (stored.confidence !== null && stored.confidence < LOW_CONFIDENCE),
      };
    },

    /** The spoken question (cached; synthesized on first request). */
    async questionAudio(userId: string, sessionId: string, questionId: string) {
      const s = await own(userId, sessionId);
      const turn = await InterviewTurnModel.findOne(
        { sessionId: s._id, questionId },
        { questionId: 1, question: 1 },
      ).lean();
      if (!turn) throw AppError.notFound('Question not found');
      try {
        return await synthesize(s, turn);
      } catch (err) {
        if (err instanceof AiUnavailableError || err instanceof AiAbortedError) {
          degraded(sessionId, {
            kind: 'TTS',
            options: ['CONTINUE_WITHOUT_AUDIO', 'SWITCH_TO_TEXT'],
          });
          throw speechUnavailable('Spoken questions are');
        }
        throw err;
      }
    },

    realtimeEnabled,

    /**
     * May the candidate stream an answer to this question now? Mirrors the
     * push-to-talk checks (state, mode, current question) plus the consent,
     * the flag and a language live transcription supports. `UNSUPPORTED`
     * sends the room to push-to-talk.
     */
    async authorizeStream(
      userId: string,
      payload: VoiceStreamStartPayload,
    ): Promise<{ language: InterviewLanguage }> {
      const s = await InterviewSessionModel.findOne({
        _id: objectId(payload.sessionId, 'Interview'),
        userId,
      })
        .lean<Session>()
        .catch(() => null);
      if (!s) throw new LiveError('NOT_FOUND', 'Interview not found');
      if (!(await realtimeEnabled(s))) {
        throw new LiveError('UNSUPPORTED', 'Live transcription is not available.');
      }
      if (s.state !== 'ACTIVE' && s.state !== 'RECONNECTING')
        throw new LiveError('INVALID_STATE', 'The interview is not active.');
      if (!consent.accepted(s, 'VOICE_PROCESSING'))
        throw new LiveError('INVALID_STATE', 'Voice processing was not agreed to.');
      const language = questionLanguage(s);
      if (!realtimeSttSupported(language)) {
        throw new LiveError('UNSUPPORTED', 'Live transcription does not support this language.');
      }
      const turn = await InterviewTurnModel.findOne(
        { sessionId: s._id, questionId: payload.questionId },
        { seq: 1, answer: 1, 'question.coding': 1 },
      ).lean();
      if (!turn || turn.seq !== s.lastSeq || turn.answer)
        throw new LiveError('STALE_QUESTION', 'This is not the current question.');
      if (turn.question.coding)
        throw new LiveError('INVALID_STATE', 'Submit your solution in the code editor.');
      return { language };
    },

    /** Called when a question is asked in a voice interview: prepare its audio before the room asks. */
    warmQuestionAudio(
      s: Session,
      turn: Pick<InterviewTurnRecord, 'questionId' | 'question'>,
      opts: { streamed?: boolean } = {},
    ) {
      // A streamed question is being spoken already (and cached when complete).
      if (!isSpokenMode(s.mode) || opts.streamed) return;
      void synthesize(s, turn).catch((err: unknown) => {
        // The room's request reports the failure (and the degraded event); here it is only logged.
        logger.warn({ err, sessionId: String(s._id) }, 'question audio could not be prepared');
      });
    },

    /** Voice ⇄ text during the interview (degrade-to-text, or the candidate's choice). */
    async switchMode(userId: string, sessionId: string, body: SwitchModeBody, ctx: ClientContext) {
      const s = await own(userId, sessionId);
      if (!SWITCHABLE.has(s.state))
        throw new AppError(409, 'INVALID_STATE', 'The interview is not in progress.');
      if (
        body.mode !== 'TEXT' &&
        (body.mode !== s.voice?.spokenMode || !consent.accepted(s, 'VOICE_PROCESSING'))
      ) {
        throw new AppError(409, 'INVALID_STATE', 'This interview was not set up for that mode.');
      }
      if (s.mode === body.mode) return { mode: s.mode };
      const at = now();
      const updated = await InterviewSessionModel.updateOne(
        { _id: s._id, userId, mode: s.mode },
        {
          $set: { mode: body.mode },
          $push: { 'voice.modeHistory': { mode: body.mode, at, reason: body.reason } },
        },
      );
      if (updated.modifiedCount === 1) {
        const event: ModeChangedEvent = { mode: body.mode, reason: body.reason };
        rooms.emit(sessionId, RtEvent.MODE_CHANGED, event);
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'interview.mode_switched',
            resourceType: 'interviewSession',
            resourceId: sessionId,
            details: { from: s.mode, to: body.mode, reason: body.reason },
          },
          ctx,
        );
      }
      return { mode: body.mode };
    },
  };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
