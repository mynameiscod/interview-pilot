import type { LiveQuestion, LiveRound, LiveTurn } from '@cbi/shared-types';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from './useInterviewRoom';

/** How often the local countdown redraws. */
export const TIMER_TICK_MS = 1_000;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Counts down from the last server sync, only while the server clock runs
 * (it stops whenever the candidate is disconnected). Announces the last five
 * minutes and the last minute once each.
 */
export function RoomTimer({
  remainingMs,
  syncedAt,
  running,
}: {
  remainingMs: number;
  syncedAt: number;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(syncedAt);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TIMER_TICK_MS);
    return () => clearInterval(timer);
  }, [running, syncedAt]);

  const left = running ? Math.max(0, remainingMs - Math.max(0, now - syncedAt)) : remainingMs;
  const warning = left <= 60_000 ? 'oneMinute' : left <= 300_000 ? 'fiveMinutes' : null;

  return (
    <div className="d-flex align-items-center gap-2">
      <i className="bi bi-clock" aria-hidden="true" />
      <span className="visually-hidden">{t('room.timeLeft')}</span>
      <span
        role="timer"
        className={`font-monospace fw-semibold ${warning === 'oneMinute' ? 'text-danger' : ''}`}
      >
        {formatClock(left)}
      </span>
      {!running && <span className="small cb-text-secondary">{t('room.clockPaused')}</span>}
      <span className="visually-hidden" aria-live="polite">
        {warning ? t(`room.timeWarning.${warning}`) : ''}
      </span>
    </div>
  );
}

const STATUS_ICON: Record<ConnectionStatus, string> = {
  connecting: 'bi-hourglass-split',
  connected: 'bi-wifi',
  reconnecting: 'bi-arrow-repeat',
  offline: 'bi-wifi-off',
};

const STATUS_STYLE: Record<ConnectionStatus, string> = {
  connecting: 'text-bg-light',
  connected: 'text-bg-light border-success',
  reconnecting: 'text-bg-warning',
  offline: 'text-bg-danger',
};

/** Connection state in words and an icon (never colour alone). */
export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className={`badge rounded-pill border fw-normal d-inline-flex align-items-center gap-1 ${STATUS_STYLE[status]}`}
    >
      <i className={`bi ${STATUS_ICON[status]}`} aria-hidden="true" />
      {t(`room.connection.${status}`)}
    </span>
  );
}

/** The interview's rounds with the current one marked. */
export function RoundStepper({ rounds, current }: { rounds: LiveRound[]; current: number }) {
  const { t } = useTranslation();
  if (rounds.length === 0) return null;
  return (
    <ol className="list-unstyled d-flex flex-wrap gap-2 mb-0" aria-label={t('room.roundsLabel')}>
      {rounds.map((round, idx) => {
        const done = idx < current || round.state === 'COMPLETED' || round.state === 'TIMED_OUT';
        const isCurrent = idx === current;
        return (
          <li
            key={`${round.type}-${idx}`}
            aria-current={isCurrent ? 'step' : undefined}
            className={`small px-2 py-1 rounded-pill border d-inline-flex align-items-center gap-1 ${
              isCurrent ? 'border-primary text-primary fw-semibold' : 'cb-border cb-text-secondary'
            }`}
          >
            {done && !isCurrent && (
              <i className="bi bi-check-circle-fill text-success" aria-hidden="true" />
            )}
            {isCurrent && <i className="bi bi-record-circle" aria-hidden="true" />}
            <span className="visually-hidden">
              {t('room.roundOf', { n: idx + 1, total: rounds.length })}
            </span>
            {t(`analysis.roundTypes.${round.type}`)}
            {done && !isCurrent && (
              <span className="visually-hidden"> ({t('room.roundDone')})</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Neutral interviewer panel: branded placeholder, thinking indicator, the
 * current question. In a voice interview it shows when the question is being
 * read aloud (the text stays as captions) and holds the playback controls.
 */
export function InterviewerPanel({
  question,
  thinking,
  questionTextId,
  speaking = false,
  controls,
}: {
  question: LiveQuestion | null;
  thinking: boolean;
  questionTextId: string;
  speaking?: boolean;
  controls?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="p-4 border cb-border rounded-3 bg-white"
      aria-labelledby="interviewer-title"
    >
      <div className="d-flex align-items-center gap-3 mb-3">
        <div
          className={`rounded-circle bg-primary text-white d-flex align-items-center justify-content-center flex-shrink-0 ${
            speaking ? 'cb-voice-speaking' : ''
          }`}
          style={{ width: '3rem', height: '3rem' }}
          aria-hidden="true"
        >
          <i className={`bi ${speaking ? 'bi-volume-up' : 'bi-chat-square-text'} fs-4`} />
        </div>
        <div>
          <h2 id="interviewer-title" className="h6 mb-0">
            {t('room.interviewer')}
          </h2>
          {question && (
            <p className="small cb-text-secondary mb-0">
              {t(`analysis.roundTypes.${question.roundType}`)}
            </p>
          )}
        </div>
        {speaking && (
          <span className="ms-auto small text-primary d-inline-flex align-items-center gap-1">
            <i className="bi bi-soundwave" aria-hidden="true" />
            {t('voice.room.speaking')}
          </span>
        )}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {question ? (
          <>
            {question.isFollowUp && (
              <span className="badge text-bg-light border cb-border fw-normal mb-2">
                {t('room.followUp')}
              </span>
            )}
            <p id={questionTextId} className="fs-5 mb-0" style={{ whiteSpace: 'pre-wrap' }}>
              {question.text}
            </p>
          </>
        ) : (
          <p className="mb-0 cb-text-secondary d-flex align-items-center gap-2">
            <span className="spinner-grow spinner-grow-sm text-secondary" aria-hidden="true" />
            {thinking ? t('room.thinking') : t('room.waiting')}
          </p>
        )}
      </div>
      {question && controls && <div className="mt-3">{controls}</div>}
    </section>
  );
}

/** Earlier questions and answers, newest last; collapsed by default. */
export function Transcript({ turns }: { turns: LiveTurn[] }) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (turns.length === 0) return null;
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h6 mb-0">
        <button
          type="button"
          className="btn btn-link p-0 text-decoration-none d-inline-flex align-items-center gap-2"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => setOpen((v) => !v)}
        >
          <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} aria-hidden="true" />
          {t('room.transcript', { count: turns.length })}
        </button>
      </h2>
      <ol id={`${id}-list`} className="list-unstyled mb-0 mt-3" hidden={!open}>
        {turns.map((turn) => (
          <li key={turn.seq} className="mb-3 pb-3 border-bottom cb-border">
            <p className="small fw-semibold mb-1">{t('room.interviewer')}</p>
            <p className="mb-2" style={{ whiteSpace: 'pre-wrap' }}>
              {turn.question}
            </p>
            <p className="small fw-semibold mb-1">
              {t('room.you')}
              {turn.answerSource === 'VOICE' && (
                <>
                  <i className="bi bi-mic ms-2 cb-text-secondary" aria-hidden="true" />
                  <span className="visually-hidden"> ({t('voice.room.spokenAnswer')})</span>
                </>
              )}
            </p>
            {turn.answer ? (
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {turn.answer}
              </p>
            ) : (
              <p className="mb-0 cb-text-secondary fst-italic">{t('room.noAnswer')}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
