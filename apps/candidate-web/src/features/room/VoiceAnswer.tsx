import { VOICE_LIMITS, type LiveQuestion, type VoiceTranscript } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from '../voice/media';
import { isSpeechUnavailable, useVoiceApi } from '../voice/voice-api';
import type { InterviewRoom } from './useInterviewRoom';
import { RecorderError, useRecorder, type RecorderProblem, type Recording } from './voice-hooks';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'review';

type VoiceProblem = RecorderProblem | 'tooShort' | 'tooLarge' | 'format' | 'stale' | 'failed';

/** Problems where typing is the practical way forward. */
const DEVICE_PROBLEMS: readonly VoiceProblem[] = [
  'denied',
  'noDevice',
  'inUse',
  'unsupported',
  'noFormat',
  'format',
];

function transcribeProblem(err: unknown): VoiceProblem {
  if (err instanceof ApiClientError) {
    if (err.code === 'UNSUPPORTED_MEDIA_TYPE') return 'format';
    if (err.code === 'PAYLOAD_TOO_LARGE') return 'tooLarge';
    if (err.code === 'INVALID_STATE') return 'stale';
    if (err.status === 400) return 'tooShort';
  }
  return 'failed';
}

/**
 * Spoken answers for the current question: record (MediaRecorder), have it
 * transcribed, review what was heard, then submit it (or record again). The
 * room keys this component by question, so a new question starts fresh.
 */
export function VoiceAnswer({
  room,
  sessionId,
  question,
  onBeforeRecord,
  onRecordingChange,
}: {
  room: InterviewRoom;
  sessionId: string;
  question: LiveQuestion | null;
  /** Stops the question audio: nothing is recorded while it plays. */
  onBeforeRecord: () => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const voice = useVoiceApi();
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<VoiceTranscript | null>(null);
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const lastRecording = useRef<Recording | null>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const questionId = question?.questionId ?? null;
  const { reportDegraded, dismissDegraded } = room;

  const transcribe = useCallback(
    async (recording: Recording) => {
      if (!questionId) return;
      lastRecording.current = recording;
      if (recording.durationMs < VOICE_LIMITS.minAnswerMs || recording.blob.size === 0) {
        setProblem('tooShort');
        setPhase('idle');
        return;
      }
      if (recording.blob.size > VOICE_LIMITS.maxAudioBytes) {
        setProblem('tooLarge');
        setPhase('idle');
        return;
      }
      setProblem(null);
      setPhase('transcribing');
      try {
        const result = await voice.transcribe(
          sessionId,
          questionId,
          recording.blob,
          recording.durationMs,
        );
        dismissDegraded('STT');
        setTranscript(result);
        setPhase('review');
      } catch (err) {
        setPhase('idle');
        if (isSpeechUnavailable(err)) reportDegraded('STT');
        else setProblem(transcribeProblem(err));
      }
    },
    [voice, sessionId, questionId, reportDegraded, dismissDegraded],
  );

  // useRecorder calls this at the length limit; `finishRef` always holds the latest version.
  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const onLimit = useCallback(() => void finishRef.current(), []);
  const recorder = useRecorder(onLimit);
  const { stop: stopRecorder } = recorder;
  const finish = useCallback(async () => {
    setPhase('transcribing');
    const recording = await stopRecorder();
    if (recording) await transcribe(recording);
    else setPhase('idle');
  }, [stopRecorder, transcribe]);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  useEffect(() => {
    onRecordingChange(recorder.recording);
  }, [recorder.recording, onRecordingChange]);
  useEffect(() => () => onRecordingChange(false), [onRecordingChange]);

  useEffect(() => {
    if (phase === 'recording') doneRef.current?.focus();
    if (phase === 'review') reviewRef.current?.focus();
  }, [phase]);

  async function startRecording() {
    if (!questionId) return;
    onBeforeRecord();
    setProblem(null);
    setTranscript(null);
    setPhase('starting');
    try {
      await recorder.start();
      setPhase('recording');
    } catch (err) {
      setProblem(err instanceof RecorderError ? err.problem : 'other');
      setPhase('idle');
    }
  }

  async function submit() {
    if (!questionId || !transcript) return;
    // The server uses its stored transcript; the text here is what the candidate reviewed.
    await room.sendAnswer(questionId, transcript.text, {
      voiceTranscriptId: transcript.transcriptId,
    });
  }

  function retrySpeech() {
    dismissDegraded('STT');
    const last = lastRecording.current;
    if (last && phase === 'idle' && !transcript) void transcribe(last);
  }

  const announcement =
    phase === 'recording'
      ? t('voice.room.announce.recording')
      : phase === 'transcribing'
        ? t('voice.room.announce.transcribing')
        : phase === 'review'
          ? t('voice.room.announce.review')
          : '';
  const unclear = transcript !== null && (transcript.lowConfidence || !transcript.text.trim());
  const maxLabel = formatDuration(VOICE_LIMITS.maxAnswerSec * 1000);

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h6">
        <i className="bi bi-mic me-2" aria-hidden="true" />
        {t('voice.room.answerTitle')}
      </h2>
      <p className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {announcement}
      </p>

      {room.degraded.STT && (
        <div className="alert alert-warning" role="alert">
          <p className="fw-semibold mb-1">{t('voice.room.sttDown.title')}</p>
          <p className="small mb-2">{t('voice.room.sttDown.body')}</p>
          <div className="d-flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={retrySpeech}>
              {t('voice.room.sttDown.retry')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={room.switchingMode}
              onClick={() => void room.switchMode('TEXT', 'STT_UNAVAILABLE')}
            >
              <i className="bi bi-keyboard me-1" aria-hidden="true" />
              {t('voice.room.switchToTyping')}
            </button>
          </div>
        </div>
      )}

      {problem && (
        <div className="alert alert-danger" role="alert">
          <p className="small mb-0">{t(`voice.room.problems.${problem}`)}</p>
          {DEVICE_PROBLEMS.includes(problem) && (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary mt-2"
              disabled={room.switchingMode}
              onClick={() => void room.switchMode('TEXT', 'DEVICE_PROBLEM')}
            >
              <i className="bi bi-keyboard me-1" aria-hidden="true" />
              {t('voice.room.switchToTyping')}
            </button>
          )}
        </div>
      )}

      {!questionId && <p className="small cb-text-secondary mb-0">{t('room.waitingHint')}</p>}

      {questionId && (phase === 'idle' || phase === 'starting') && (
        <>
          <p id={`${id}-hint`} className="small cb-text-secondary">
            {t('voice.room.hint', { max: maxLabel })}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            aria-describedby={`${id}-hint`}
            disabled={phase === 'starting' || room.sending}
            onClick={() => void startRecording()}
          >
            <i className="bi bi-mic-fill me-2" aria-hidden="true" />
            {phase === 'starting' ? t('voice.room.starting') : t('voice.room.start')}
          </button>
        </>
      )}

      {phase === 'recording' && (
        <div className="d-flex flex-column gap-3">
          <div className="d-flex flex-wrap align-items-center gap-3">
            <span className="d-inline-flex align-items-center gap-2 fw-semibold text-danger">
              <span className="cb-voice-recording-dot" aria-hidden="true" />
              {t('voice.room.recording')}
            </span>
            <span className="font-monospace">
              <span className="visually-hidden">{t('voice.room.elapsed')} </span>
              {formatDuration(recorder.elapsedMs)} / {maxLabel}
            </span>
          </div>
          <div className="progress cb-voice-meter" style={{ height: '0.5rem' }} aria-hidden="true">
            <div
              className="progress-bar bg-success"
              style={{ width: `${Math.round(recorder.level * 100)}%` }}
            />
          </div>
          <div>
            <button
              ref={doneRef}
              type="button"
              className="btn btn-danger btn-lg"
              onClick={() => void finish()}
            >
              <i className="bi bi-stop-fill me-2" aria-hidden="true" />
              {t('voice.room.done')}
            </button>
          </div>
        </div>
      )}

      {phase === 'transcribing' && (
        <p className="mb-0 d-flex align-items-center gap-2" role="status">
          <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
          {t('voice.room.transcribing')}
        </p>
      )}

      {phase === 'review' && transcript && (
        <div>
          <h3 ref={reviewRef} tabIndex={-1} className="h6">
            {t('voice.room.heardTitle')}
          </h3>
          {transcript.text.trim() ? (
            <blockquote
              className="p-3 rounded-3 cb-surface-muted mb-2"
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {transcript.text}
            </blockquote>
          ) : (
            <p className="fst-italic cb-text-secondary mb-2">{t('voice.room.heardNothing')}</p>
          )}
          {unclear && (
            <p className="small text-warning-emphasis mb-2">
              <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
              {t('voice.room.unclear')}
            </p>
          )}
          <div className="d-flex flex-wrap align-items-center gap-2 mt-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={room.sending}
              onClick={() => void submit()}
            >
              {room.sending ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                  {t('room.sending')}
                </>
              ) : (
                <>
                  <i className="bi bi-send me-2" aria-hidden="true" />
                  {t('voice.room.submit')}
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary"
              disabled={room.sending}
              onClick={() => void startRecording()}
            >
              <i className="bi bi-arrow-counterclockwise me-2" aria-hidden="true" />
              {t('voice.room.recordAgain')}
            </button>
            {room.sending && room.connection !== 'connected' && (
              <span className="small cb-text-secondary">{t('room.sendWhenBack')}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
