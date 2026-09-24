import { ANSWER_LIMITS } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { queryKeys } from '../interviews/interviews-api';
import { useCameraStream, useInterviewRecording, type TrackKind } from '../media/video-hooks';
import { clearDraft, loadDraft, saveDraft } from './drafts';
import { useIntegrityObservations } from './integrity';
import { ConnectionPill, InterviewerPanel, RoundStepper, RoomTimer, Transcript } from './RoomParts';
import { useInterviewRoom, type InterviewRoom } from './useInterviewRoom';
import { VoiceAnswer } from './VoiceAnswer';
import { SelfView } from './SelfView';
import { useQuestionAudio } from './voice-hooks';
import '../voice/voice.scss';

type QuestionAudio = ReturnType<typeof useQuestionAudio>;

/** Playback controls under the question in a voice interview. */
function QuestionAudioControls({ audio, recording }: { audio: QuestionAudio; recording: boolean }) {
  const { t } = useTranslation();
  switch (audio.status) {
    case 'loading':
      return (
        <p className="small cb-text-secondary mb-0 d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
          {t('voice.room.audioLoading')}
        </p>
      );
    case 'playing':
      return (
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={audio.stop}>
          <i className="bi bi-stop-fill me-1" aria-hidden="true" />
          {t('voice.room.stopAudio')}
        </button>
      );
    case 'ready':
      return (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={recording}
          onClick={audio.replay}
        >
          <i className="bi bi-arrow-repeat me-1" aria-hidden="true" />
          {t('voice.room.repeat')}
        </button>
      );
    case 'blocked':
      return (
        <div>
          <p className="small cb-text-secondary mb-2">{t('voice.room.autoplayBlocked')}</p>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={recording}
            onClick={audio.replay}
          >
            <i className="bi bi-play-fill me-1" aria-hidden="true" />
            {t('voice.room.playQuestion')}
          </button>
        </div>
      );
    case 'unavailable':
      return (
        <p className="small cb-text-secondary mb-0">
          <i className="bi bi-volume-mute me-1" aria-hidden="true" />
          {t('voice.room.audioUnavailable')}
        </p>
      );
    default:
      return null;
  }
}

/**
 * "Type instead" in a voice or video interview; "Answer by voice" (or "on
 * camera") to go back to the interview's own spoken mode.
 */
function ModeSwitch({ room }: { room: InterviewRoom }) {
  const { t } = useTranslation();
  const spoken = room.mode !== 'TEXT';
  if (!spoken && !room.voiceEnabled) return null;
  const video = room.spokenMode === 'VIDEO';
  return (
    <div className="d-flex justify-content-end">
      <button
        type="button"
        className="btn btn-link btn-sm p-0"
        disabled={room.switchingMode}
        onClick={() => void room.switchMode(spoken ? 'TEXT' : room.spokenMode, 'CANDIDATE_CHOICE')}
      >
        <i
          className={`bi ${spoken ? 'bi-keyboard' : video ? 'bi-camera-video' : 'bi-mic'} me-1`}
          aria-hidden="true"
        />
        {spoken
          ? t('voice.room.typeInstead')
          : video
            ? t('video.room.answerOnCamera')
            : t('voice.room.answerByVoice')}
      </button>
    </div>
  );
}

/** Questions cannot be read aloud: carry on reading them, or switch to typing. */
function TtsDownBanner({ room }: { room: InterviewRoom }) {
  const { t } = useTranslation();
  return (
    <div className="alert alert-warning" role="alert">
      <p className="fw-semibold mb-1">{t('voice.room.ttsDown.title')}</p>
      <p className="small mb-2">{t('voice.room.ttsDown.body')}</p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={() => room.dismissDegraded('TTS')}
        >
          {t('voice.room.ttsDown.continue')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={room.switchingMode}
          onClick={() => void room.switchMode('TEXT', 'TTS_UNAVAILABLE')}
        >
          <i className="bi bi-keyboard me-1" aria-hidden="true" />
          {t('voice.room.switchToTyping')}
        </button>
      </div>
    </div>
  );
}

/** Answer box: keeps an unsent draft per question and clears it only once the server has it. */
function AnswerForm({ room, sessionId }: { room: InterviewRoom; sessionId: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const question = room.question;
  const questionId = question?.questionId ?? null;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const text = questionId ? (drafts[questionId] ?? loadDraft(sessionId, questionId)) : '';
  const tooLong = text.length > ANSWER_LIMITS.maxChars;
  const canSend = Boolean(questionId) && !room.sending && text.trim().length > 0 && !tooLong;

  function update(value: string) {
    if (!questionId) return;
    setDrafts((d) => ({ ...d, [questionId]: value }));
    saveDraft(sessionId, questionId, value);
  }

  async function submit() {
    if (!canSend || !questionId) return;
    const result = await room.sendAnswer(questionId, text);
    if (result === 'sent') {
      clearDraft(sessionId, questionId);
      setDrafts((d) => ({ ...d, [questionId]: '' }));
    }
  }

  /** With session observations on, a paste is noted by its length only (never its text). */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!room.integrityTracking) return;
    const pasted = e.clipboardData?.getData('text') ?? '';
    room.reportIntegrity('PASTE', pasted.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const count = new Intl.NumberFormat(i18n.resolvedLanguage).format(text.length);
  const max = new Intl.NumberFormat(i18n.resolvedLanguage).format(ANSWER_LIMITS.maxChars);

  return (
    <form
      noValidate
      className="p-4 border cb-border rounded-3 bg-white"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-answer`} className="form-label fw-semibold">
        {t('room.answerLabel')}
      </label>
      <textarea
        id={`${id}-answer`}
        className={`form-control ${tooLong ? 'is-invalid' : ''}`}
        rows={7}
        value={text}
        readOnly={!questionId || room.sending}
        aria-describedby={[question ? 'room-question-text' : null, `${id}-hint`, `${id}-count`]
          .filter(Boolean)
          .join(' ')}
        aria-invalid={tooLong || undefined}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="d-flex flex-wrap justify-content-between gap-2 mt-1 small">
        <span id={`${id}-hint`} className="cb-text-secondary">
          {questionId ? t('room.shortcutHint') : t('room.waitingHint')}
        </span>
        <span id={`${id}-count`} className={tooLong ? 'text-danger' : 'cb-text-secondary'}>
          {t('room.charCount', { count: text.length, formatted: count, max })}
        </span>
      </div>
      {tooLong && (
        <div className="text-danger small mt-1" role="alert">
          {t('room.tooLong', { max })}
        </div>
      )}
      <div className="d-flex flex-wrap align-items-center gap-2 mt-3">
        <button type="submit" className="btn btn-primary" disabled={!canSend}>
          {room.sending ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              {t('room.sending')}
            </>
          ) : (
            <>
              <i className="bi bi-send me-2" aria-hidden="true" />
              {t('room.send')}
            </>
          )}
        </button>
        {room.sending && room.connection !== 'connected' && (
          <span className="small cb-text-secondary">{t('room.sendWhenBack')}</span>
        )}
      </div>
    </form>
  );
}

/** Non-blocking notice while the connection is down; the interview continues when it returns. */
function ReconnectingOverlay({ room }: { room: InterviewRoom }) {
  const { t } = useTranslation();
  return (
    <div
      className="position-fixed bottom-0 start-0 end-0 p-3 d-flex justify-content-center"
      style={{ zIndex: 1050, pointerEvents: 'none' }}
    >
      <section
        className="p-3 border cb-border rounded-3 bg-white shadow-sm d-flex flex-wrap align-items-center gap-3"
        style={{ pointerEvents: 'auto', maxWidth: '40rem' }}
        aria-labelledby="reconnecting-title"
      >
        <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
        <div className="flex-grow-1">
          <h2 id="reconnecting-title" className="h6 mb-1">
            {room.connection === 'offline' ? t('room.offlineTitle') : t('room.reconnectingTitle')}
          </h2>
          <p className="small mb-0">{t('room.reconnectingBody')}</p>
          <p className="small cb-text-secondary mb-0">
            {room.retryInSec !== null
              ? t('room.retryIn', { count: room.retryInSec })
              : t('room.retryingAutomatically')}
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-outline-primary" onClick={room.retryNow}>
          {t('room.retryNow')}
        </button>
      </section>
    </div>
  );
}

function EndInterview({ room }: { room: InterviewRoom }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-outline-danger btn-sm"
        onClick={() => setConfirming(true)}
      >
        {t('room.end.action')}
      </button>
    );
  }
  return (
    <section
      className="p-3 border border-danger rounded-3 bg-white w-100"
      aria-labelledby="end-confirm-title"
    >
      <h2 id="end-confirm-title" ref={headingRef} tabIndex={-1} className="h6">
        {t('room.end.title')}
      </h2>
      <p className="small mb-2">{t('room.end.body')}</p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={room.ending}
          // Ending moves the room to the complete screen (see RoomPage).
          onClick={() => void room.end()}
        >
          {room.ending ? t('room.end.ending') : t('room.end.confirm')}
        </button>
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={() => setConfirming(false)}
        >
          {t('room.end.keep')}
        </button>
      </div>
    </section>
  );
}

const PROBLEM_KEYS = {
  stale: 'room.problems.stale',
  sendFailed: 'room.problems.sendFailed',
  endFailed: 'room.problems.endFailed',
  modeFailed: 'room.problems.modeFailed',
} as const;

export function RoomPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const room = useInterviewRoom(id);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const completePath = `/app/interviews/${id}/complete`;
  const finished = room.finished;

  // Voice and video: the current question is read aloud (stopped and released in text mode).
  const voiceMode = room.joined && room.mode !== 'TEXT' && !finished;
  const videoMode = room.joined && room.mode === 'VIDEO' && !finished;
  const { reportDegraded, reportIntegrity, integrityTracking } = room;
  const observing = room.joined && integrityTracking && !finished;

  // Video: the camera for the self-view and (with consent) the recording.
  const [cameraLost, setCameraLost] = useState(false);
  const onTrackEnded = useCallback(
    (kind: TrackKind) => {
      if (kind === 'video') setCameraLost(true);
      if (observing) reportIntegrity(kind === 'video' ? 'CAMERA_LOST' : 'MICROPHONE_LOST');
    },
    [observing, reportIntegrity],
  );
  const camera = useCameraStream(videoMode, onTrackEnded);
  const uploads = useInterviewRecording({
    sessionId: id,
    stream: camera.stream,
    active: videoMode && room.recording,
    // Over, or no longer on camera: stop, upload what is left, then finalize.
    ended: Boolean(finished) || (room.joined && room.mode !== 'VIDEO'),
  });
  useIntegrityObservations(observing, reportIntegrity);

  const onTtsDown = useCallback(() => reportDegraded('TTS'), [reportDegraded]);
  const audio = useQuestionAudio(
    id,
    voiceMode ? (room.question?.questionId ?? null) : null,
    onTtsDown,
  );
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!finished) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.interview(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.credits });
    void navigate(completePath, { replace: true });
  }, [finished, completePath, id, navigate, queryClient]);

  if (room.problem === 'notStarted') {
    return <Navigate to={`/app/interviews/${id}/start`} replace />;
  }
  if (room.problem === 'signedOut') {
    const next = encodeURIComponent(location.pathname);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (room.problem === 'notFound') {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('analysis.loadErrorTitle')}</h1>
        <p className="cb-text-secondary">{t('room.notFound')}</p>
        <Link to="/app" className="btn btn-outline-primary">
          {t('interview.backToDashboard')}
        </Link>
      </div>
    );
  }
  if (!room.joined) {
    return (
      <div className="container py-5">
        <div className="d-flex align-items-center gap-3 mb-3">
          <ConnectionPill status={room.connection} />
        </div>
        <RouteLoading />
        {room.connection !== 'connecting' && room.connection !== 'connected' && (
          <ReconnectingOverlay room={room} />
        )}
      </div>
    );
  }

  const earlier = room.turns.filter((turn) => turn.questionId !== room.question?.questionId);
  const problemKey =
    room.problem && room.problem in PROBLEM_KEYS
      ? PROBLEM_KEYS[room.problem as keyof typeof PROBLEM_KEYS]
      : null;

  return (
    <div className="container-lg py-3">
      <header className="d-flex flex-column gap-2 pb-3 mb-3 border-bottom cb-border">
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
          <h1 className="h4 mb-0 text-break">{room.title}</h1>
          <div className="d-flex flex-wrap align-items-center gap-3">
            <RoomTimer
              remainingMs={room.remainingMs}
              syncedAt={room.syncedAt}
              running={room.clockRunning && room.connection === 'connected'}
            />
            <ConnectionPill status={room.connection} />
          </div>
        </div>
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
          <RoundStepper rounds={room.rounds} current={room.roundIdx} />
          <EndInterview room={room} />
        </div>
        {room.integrityTracking && (
          <p className="small cb-text-secondary mb-0">
            <i className="bi bi-info-circle me-1" aria-hidden="true" />
            {t('room.observationsOn')}
          </p>
        )}
      </header>

      {problemKey && (
        <div className="alert alert-warning d-flex align-items-start gap-2" role="alert">
          <span className="flex-grow-1">{t(problemKey)}</span>
          <button
            type="button"
            className="btn-close"
            aria-label={t('room.dismiss')}
            onClick={room.dismissProblem}
          />
        </div>
      )}

      <div className="row g-4">
        <div className="col-lg-5 d-flex flex-column gap-4">
          {voiceMode && room.degraded.TTS && <TtsDownBanner room={room} />}
          <InterviewerPanel
            question={room.question}
            thinking={room.thinking}
            questionTextId="room-question-text"
            speaking={voiceMode && audio.status === 'playing'}
            controls={
              voiceMode ? <QuestionAudioControls audio={audio} recording={recording} /> : undefined
            }
          />
          <p className="small cb-text-secondary mb-0">
            <i className="bi bi-shield-check me-1" aria-hidden="true" />
            {t('room.noScoresNote')}
          </p>
        </div>
        <div className="col-lg-7 d-flex flex-column gap-4">
          <ModeSwitch room={room} />
          {(room.voiceEnabled || room.mode === 'VOICE') && (
            <p className="visually-hidden" aria-live="polite">
              {t(`voice.room.modeNow.${room.mode}`)}
            </p>
          )}
          {voiceMode ? (
            <VoiceAnswer
              key={room.question?.questionId ?? 'waiting'}
              room={room}
              sessionId={id}
              question={room.question}
              onBeforeRecord={audio.stop}
              onRecordingChange={setRecording}
            />
          ) : (
            <AnswerForm room={room} sessionId={id} />
          )}
          <Transcript turns={earlier} />
        </div>
      </div>

      {videoMode && (
        <SelfView
          stream={camera.stream}
          unavailable={camera.problem !== null}
          cameraLost={cameraLost}
          recording={uploads.recording}
          uploads={uploads}
        />
      )}
      {!videoMode && uploads.waiting > 0 && (
        <p className="small cb-text-secondary mt-3 mb-0" role="status">
          {t('video.uploads.waiting', { count: uploads.waiting })}
        </p>
      )}

      {room.connection !== 'connected' && <ReconnectingOverlay room={room} />}
    </div>
  );
}
