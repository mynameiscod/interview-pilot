import { z } from 'zod';

/**
 * Voice interviews (Phase 7). The pipeline is cascaded and owned by the
 * interview engine: the candidate's recorded answer is transcribed (STT), the
 * transcript is the answer, and each question is spoken with TTS. Audio is
 * sent to the speech providers and not stored by the platform.
 */

export const VOICE_LIMITS = {
  /** Largest recorded answer accepted for transcription. */
  maxAudioBytes: 10 * 1024 * 1024,
  /** Longest single spoken answer. */
  maxAnswerSec: 300,
  /** Shorter recordings are treated as accidental. */
  minAnswerMs: 500,
  /** A device check older than this must be repeated before starting. */
  deviceCheckMaxAgeMs: 24 * 3600_000,
  /** How long a transcript can wait to be submitted as the answer. */
  transcriptTtlSec: 3600,
} as const;

/** Audio containers accepted for transcription (MediaRecorder outputs and common files). */
export const VOICE_AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
] as const;
export const VoiceAudioType = z.enum(VOICE_AUDIO_TYPES);
export type VoiceAudioType = z.infer<typeof VoiceAudioType>;

/** Version of the voice processing notice the candidate accepts. */
export const VOICE_CONSENT_VERSION = 'voice-2026-09';

// ---- Device check ---------------------------------------------------------------------

export const DeviceCheckStatus = z.enum(['PASS', 'WARN', 'FAIL']);
export type DeviceCheckStatus = z.infer<typeof DeviceCheckStatus>;

/** Results measured in the browser (design §9); FAIL on a required check blocks a voice start. */
export const DeviceCheckBody = z.object({
  /** Permission granted and input level seen. Required. */
  microphone: DeviceCheckStatus,
  /** MediaRecorder with a supported audio format. Required. */
  recorder: DeviceCheckStatus,
  /** The candidate heard the test sound. */
  speaker: DeviceCheckStatus,
  /** Round trip to the API. */
  network: DeviceCheckStatus,
  /** The server's speech services, as reported by /voice/health. */
  speechService: DeviceCheckStatus,
  mimeType: z.string().trim().max(100).nullable(),
  rttMs: z.number().int().min(0).max(60_000).nullable(),
  /** Browser name and version, for support (no fingerprinting detail). */
  browser: z.string().trim().max(120).nullable(),
});
export type DeviceCheckBody = z.infer<typeof DeviceCheckBody>;

export const DeviceCheckResult = DeviceCheckBody.extend({
  at: z.iso.datetime(),
  /** Microphone and recorder did not fail. */
  passed: z.boolean(),
});
export type DeviceCheckResult = z.infer<typeof DeviceCheckResult>;

/** Required checks: without them a spoken interview cannot work. */
export const deviceCheckPassed = (r: Pick<DeviceCheckBody, 'microphone' | 'recorder'>) =>
  r.microphone !== 'FAIL' && r.recorder !== 'FAIL';

export const VoiceConsentBody = z.object({
  accepted: z.literal(true),
  version: z.literal(VOICE_CONSENT_VERSION),
});
export type VoiceConsentBody = z.infer<typeof VoiceConsentBody>;

/** What a voice interview still needs before it can start. */
export const VoiceReadiness = z.object({
  deviceCheck: DeviceCheckResult.nullable(),
  consentAt: z.iso.datetime().nullable(),
  /** A recent passing device check and consent are both in place. */
  ready: z.boolean(),
});
export type VoiceReadiness = z.infer<typeof VoiceReadiness>;

// ---- Speech services --------------------------------------------------------------------

export const SpeechServiceStatus = z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']);
export type SpeechServiceStatus = z.infer<typeof SpeechServiceStatus>;

/** DEGRADED: only fallback models are usable (e.g. the first choice's circuit is open). */
export const VoiceHealth = z.object({ stt: SpeechServiceStatus, tts: SpeechServiceStatus });
export type VoiceHealth = z.infer<typeof VoiceHealth>;

// ---- Answers ---------------------------------------------------------------------------------

/** Multipart fields sent with the recorded answer (`audio` is the file). */
export const TranscribeFields = z.object({
  questionId: z.string().min(1).max(64),
  /** Recording length measured by the browser. */
  durationMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(VOICE_LIMITS.maxAnswerSec * 1000),
});
export type TranscribeFields = z.infer<typeof TranscribeFields>;

/** A transcribed answer, shown to the candidate before it is submitted. */
export const VoiceTranscript = z.object({
  transcriptId: z.uuid(),
  questionId: z.string(),
  text: z.string(),
  durationSec: z.number(),
  /** Language detected by the speech model, when reported. */
  language: z.string().nullable(),
  /** The model was unsure; the room suggests re-recording. */
  lowConfidence: z.boolean(),
});
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;

// ---- Switching modes -----------------------------------------------------------------------

export const ModeSwitchReason = z.enum([
  'CANDIDATE_CHOICE',
  'STT_UNAVAILABLE',
  'TTS_UNAVAILABLE',
  'DEVICE_PROBLEM',
]);
export type ModeSwitchReason = z.infer<typeof ModeSwitchReason>;

export const SwitchModeBody = z.object({
  mode: z.enum(['TEXT', 'VOICE']),
  reason: ModeSwitchReason,
});
export type SwitchModeBody = z.infer<typeof SwitchModeBody>;

/** `interview:mode` */
export const ModeChangedEvent = z.object({
  mode: z.enum(['TEXT', 'VOICE']),
  reason: ModeSwitchReason,
});
export type ModeChangedEvent = z.infer<typeof ModeChangedEvent>;

/** `interview:degraded`: every model for a speech feature failed. The interview state is unchanged. */
export const DegradedEvent = z.object({
  kind: z.enum(['STT', 'TTS']),
  /** Actions the room offers. */
  options: z.array(z.enum(['RETRY', 'SWITCH_TO_TEXT', 'CONTINUE_WITHOUT_AUDIO'])),
});
export type DegradedEvent = z.infer<typeof DegradedEvent>;
