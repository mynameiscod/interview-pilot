import { ANSWER_LIMITS, REALTIME_VOICE } from '@cbi/shared-types';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RealtimeVoice } from './realtime-voice';
import type { InterviewRoom } from './useInterviewRoom';

/** Why push-to-talk took over, above the record button. */
export function RealtimeFallbackNotice({ voice }: { voice: RealtimeVoice }) {
  const { t } = useTranslation();
  // Device problems are explained by the recorder itself.
  if (!voice.fallback || voice.fallback === 'device') return null;
  return (
    <p className="small cb-text-secondary mb-0" role="status">
      <i className="bi bi-info-circle me-1" aria-hidden="true" />
      {t(`voice.room.live.fallback.${voice.fallback}`)}
    </p>
  );
}

/**
 * The spoken answer in realtime voice: the words appear as the candidate
 * speaks; when the answer seems complete a short countdown sends it (keep
 * talking to continue, send now, or edit). The candidate can choose to
 * always review first. The interviewer's question can be interrupted by
 * simply speaking.
 */
export function RealtimeVoiceAnswer({
  room,
  voice,
  reviewBeforeSending,
  onReviewBeforeSendingChange,
}: {
  room: InterviewRoom;
  voice: RealtimeVoice;
  reviewBeforeSending: boolean;
  onReviewBeforeSendingChange: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { phase } = voice;
  const [edited, setEdited] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase === 'editing') editRef.current?.focus();
    if (phase === 'review') reviewRef.current?.focus();
  }, [phase]);

  const startEditing = () => {
    setEdited([voice.text, voice.interim].filter(Boolean).join(' '));
    voice.edit();
  };

  const seconds = voice.graceLeftMs === null ? 0 : Math.ceil(voice.graceLeftMs / 1000);
  const heard = (
    <blockquote
      className="p-3 rounded-3 cb-surface-muted mb-2"
      style={{ whiteSpace: 'pre-wrap', minHeight: '4.5rem' }}
      aria-live="polite"
    >
      {voice.text || voice.interim ? (
        <>
          {voice.text}
          {voice.interim && (
            <span className="cb-text-secondary">
              {voice.text ? ' ' : ''}
              {voice.interim}
            </span>
          )}
        </>
      ) : (
        <span className="fst-italic cb-text-secondary">{t('voice.room.live.nothingYet')}</span>
      )}
    </blockquote>
  );
  const meter = (
    <div className="progress cb-voice-meter" style={{ height: '0.35rem' }} aria-hidden="true">
      <div
        className="progress-bar bg-success"
        style={{ width: `${Math.round(voice.level * 100)}%` }}
      />
    </div>
  );

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h6">
        <i className="bi bi-mic me-2" aria-hidden="true" />
        {t('voice.room.answerTitle')}
      </h2>
      <p className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {phase === 'grace'
          ? t('voice.room.live.announce.grace', { seconds: REALTIME_VOICE.graceMs / 1000 })
          : phase === 'listening'
            ? t('voice.room.live.announce.listening')
            : phase === 'review'
              ? t('voice.room.announce.review')
              : ''}
      </p>

      {phase === 'idle' && <p className="small cb-text-secondary mb-0">{t('room.waitingHint')}</p>}

      {phase === 'interviewer' && (
        <p className="small cb-text-secondary mb-0">
          <i className="bi bi-soundwave me-1" aria-hidden="true" />
          {t('voice.room.live.interruptHint')}
        </p>
      )}

      {(phase === 'listening' || phase === 'finishing') && (
        <div className="d-flex flex-column gap-2">
          <span className="d-inline-flex align-items-center gap-2 fw-semibold text-danger">
            <span className="cb-voice-recording-dot" aria-hidden="true" />
            {phase === 'finishing'
              ? t('voice.room.live.finishing')
              : t('voice.room.live.listening')}
          </span>
          {meter}
          {heard}
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase === 'finishing' || !voice.streamId || !(voice.text || voice.interim)}
              onClick={voice.sendNow}
            >
              <i className="bi bi-send me-2" aria-hidden="true" />
              {t('voice.room.live.sendNow')}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary"
              disabled={phase === 'finishing' || !(voice.text || voice.interim)}
              onClick={startEditing}
            >
              <i className="bi bi-pencil me-2" aria-hidden="true" />
              {t('voice.room.live.edit')}
            </button>
          </div>
        </div>
      )}

      {phase === 'grace' && (
        <div className="d-flex flex-column gap-2">
          {heard}
          <p className="fw-semibold mb-0" role="status">
            {t('voice.room.live.sendingIn', { seconds })}
          </p>
          <p className="small cb-text-secondary mb-1">{t('voice.room.live.keepTalking')}</p>
          <div className="d-flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={voice.sendNow}>
              <i className="bi bi-send me-2" aria-hidden="true" />
              {t('voice.room.live.sendNow')}
            </button>
            <button type="button" className="btn btn-outline-secondary" onClick={startEditing}>
              <i className="bi bi-pencil me-2" aria-hidden="true" />
              {t('voice.room.live.edit')}
            </button>
          </div>
        </div>
      )}

      {phase === 'review' && (
        <div>
          <h3 ref={reviewRef} tabIndex={-1} className="h6">
            {t('voice.room.heardTitle')}
          </h3>
          {voice.text.trim() ? (
            heard
          ) : (
            <p className="fst-italic cb-text-secondary mb-2">{t('voice.room.heardNothing')}</p>
          )}
          {voice.transcript?.lowConfidence && voice.text.trim() && (
            <p className="small text-warning-emphasis mb-2">
              <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
              {t('voice.room.live.unclear')}
            </p>
          )}
          <p className="small cb-text-secondary">{t('voice.room.live.speakToContinue')}</p>
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={room.sending || !voice.transcript || !voice.text.trim()}
              onClick={() => voice.submit()}
            >
              <i className="bi bi-send me-2" aria-hidden="true" />
              {t('voice.room.submit')}
            </button>
            <button type="button" className="btn btn-outline-secondary" onClick={startEditing}>
              <i className="bi bi-pencil me-2" aria-hidden="true" />
              {t('voice.room.live.edit')}
            </button>
          </div>
        </div>
      )}

      {phase === 'editing' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            voice.submit(edited);
          }}
        >
          <label htmlFor={`${id}-edit`} className="form-label fw-semibold">
            {t('voice.room.live.editLabel')}
          </label>
          <textarea
            ref={editRef}
            id={`${id}-edit`}
            className="form-control mb-2"
            rows={5}
            maxLength={ANSWER_LIMITS.maxChars}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={room.sending || !edited.trim()}
          >
            <i className="bi bi-send me-2" aria-hidden="true" />
            {t('voice.room.submit')}
          </button>
        </form>
      )}

      {phase === 'submitting' && (
        <p className="mb-0 d-flex align-items-center gap-2" role="status">
          <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
          {t('room.sending')}
          {room.connection !== 'connected' && (
            <span className="small cb-text-secondary">{t('room.sendWhenBack')}</span>
          )}
        </p>
      )}

      {phase === 'paused' && (
        <div className="alert alert-warning mb-0" role="alert">
          <p className="small mb-2">{t('voice.room.live.paused')}</p>
          {heard}
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={startEditing}>
            <i className="bi bi-pencil me-1" aria-hidden="true" />
            {t('voice.room.live.edit')}
          </button>
        </div>
      )}

      {phase !== 'editing' && phase !== 'submitting' && (
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-3">
          <div className="form-check mb-0">
            <input
              id={`${id}-review`}
              type="checkbox"
              className="form-check-input"
              checked={reviewBeforeSending}
              onChange={(e) => onReviewBeforeSendingChange(e.target.checked)}
            />
            <label htmlFor={`${id}-review`} className="form-check-label small">
              {t('voice.room.live.reviewPreference')}
            </label>
          </div>
          <button
            type="button"
            className="btn btn-link btn-sm p-0"
            onClick={voice.switchToPushToTalk}
          >
            {t('voice.room.live.usePushToTalk')}
          </button>
        </div>
      )}
    </section>
  );
}
