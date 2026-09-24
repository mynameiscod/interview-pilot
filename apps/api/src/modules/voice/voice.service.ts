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
  RtEvent,
  VOICE_LIMITS,
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
import type { ClientContext } from '../../lib/request-context.js';
import type { ConsentService } from '../consent/consent.service.js';
import type { RoomEmitter } from '../live/live.service.js';

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

// ---- Service -----------------------------------------------------------------------------------

const LIVE = new Set(['ACTIVE', 'ROUND_TRANSITION']);
const SWITCHABLE = new Set(['ACTIVE', 'ROUND_TRANSITION', 'RECONNECTING', 'PAUSED']);
const PRE_START = new Set(['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START']);
const AUDIO_TTL_SEC = 2 * 3600;
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
  now?: () => Date;
}

export function createVoiceService(deps: Deps) {
  const { ai, redis, logger, rooms, audit, transcripts, consent } = deps;
  const now = deps.now ?? (() => new Date());
  /** One synthesis per question per process, however many requests wait for it. */
  const inFlight = new Map<string, Promise<{ audio: Buffer; mimeType: string }>>();

  async function own(userId: string, sessionId: string): Promise<Session> {
    const s = await InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      userId,
    }).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    return s;
  }

  const language = (s: Session) => (s.language === 'auto' ? null : s.language);
  const audioKey = (questionId: string) => `cbi:voice:tts:${questionId}`;

  function degraded(sessionId: string, event: DegradedEvent) {
    rooms.emit(sessionId, RtEvent.DEGRADED, event);
  }

  async function synthesize(
    s: Session,
    turn: Pick<InterviewTurnRecord, 'questionId' | 'question'>,
  ) {
    const cached = await redis.getBuffer(audioKey(turn.questionId)).catch(() => null);
    const cachedType = cached ? await redis.get(`${audioKey(turn.questionId)}:type`) : null;
    if (cached && cachedType) return { audio: cached, mimeType: cachedType };
    let pending = inFlight.get(turn.questionId);
    if (!pending) {
      pending = (async () => {
        const r = await ai.router.synthesize(
          { text: turn.question.text, language: language(s) },
          { userId: String(s.userId), sessionId: String(s._id) },
        );
        const audio = Buffer.from(r.result.audio);
        await redis
          .multi()
          .set(audioKey(turn.questionId), audio, 'EX', AUDIO_TTL_SEC)
          .set(`${audioKey(turn.questionId)}:type`, r.result.mimeType, 'EX', AUDIO_TTL_SEC)
          .exec()
          .catch((err: unknown) => logger.warn({ err }, 'question audio cache write failed'));
        return { audio, mimeType: r.result.mimeType };
      })().finally(() => inFlight.delete(turn.questionId));
      inFlight.set(turn.questionId, pending);
    }
    return pending;
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
      let result;
      try {
        result = await ai.router.transcribe(
          {
            audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
            mimeType,
            language: language(s),
            durationSec: fields.durationMs / 1000,
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
        durationSec: result.usage.audioSec ?? fields.durationMs / 1000,
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

    /** Called when a question is asked in a voice interview: prepare its audio before the room asks. */
    warmQuestionAudio(s: Session, turn: Pick<InterviewTurnRecord, 'questionId' | 'question'>) {
      if (!isSpokenMode(s.mode)) return;
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
