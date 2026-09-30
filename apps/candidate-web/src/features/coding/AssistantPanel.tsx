import { AI_ASSIST_LIMITS, type AssistantState } from '@cbi/shared-types';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The in-editor AI assistant of an AI-allowed coding round. The candidate
 * sees plainly that the conversation is saved and reviewed; once the
 * solution is submitted the conversation stays readable but closed.
 */
export function AssistantPanel({
  state,
  busy,
  closed,
  problem,
  onSend,
}: {
  state: AssistantState;
  busy: boolean;
  /** Submitted, or the question is no longer open. */
  closed: boolean;
  /** A notice about the last message (rate limited, used up, failed). */
  problem: 'rateLimited' | 'usedUp' | 'failed' | null;
  onSend: (message: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const left = Math.max(0, state.maxTurns - state.turnsUsed);
  const tooLong = draft.trim().length > AI_ASSIST_LIMITS.maxMessageChars;
  const canSend = !closed && !busy && left > 0 && draft.trim() !== '' && !tooLong;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.messages.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    if (await onSend(draft.trim())) setDraft('');
  }

  return (
    <section className="border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <div className="p-3 border-bottom cb-border">
        <h3 id={`${id}-title`} className="h6 mb-1 d-flex align-items-center gap-2">
          <i className="bi bi-stars" aria-hidden="true" />
          {t('coding.assistant.title')}
        </h3>
        <p className="small cb-text-secondary mb-0">
          {state.allowFullSolutions
            ? t('coding.assistant.policyFull')
            : t('coding.assistant.policyHints')}
        </p>
      </div>
      <ol
        ref={listRef}
        className="list-unstyled mb-0 p-3 d-flex flex-column gap-2 overflow-auto"
        style={{ maxHeight: '20rem' }}
        aria-label={t('coding.assistant.conversation')}
        aria-live="polite"
      >
        {state.messages.length === 0 && (
          <li className="small cb-text-secondary">{t('coding.assistant.empty')}</li>
        )}
        {state.messages.map((m, i) => (
          <li
            key={i}
            className={`p-2 rounded-2 small ${m.role === 'CANDIDATE' ? 'bg-light align-self-end' : 'border cb-border'}`}
          >
            <p className="fw-semibold mb-1">
              {m.role === 'CANDIDATE' ? t('coding.assistant.you') : t('coding.assistant.assistant')}
            </p>
            {m.unavailable ? (
              <p className="mb-0 cb-text-secondary">{t('coding.assistant.unavailable')}</p>
            ) : (
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                {m.text}
              </p>
            )}
            {m.redacted && (
              <p className="mb-0 mt-1 cb-text-secondary">
                <i className="bi bi-info-circle me-1" aria-hidden="true" />
                {t('coding.assistant.redacted')}
              </p>
            )}
          </li>
        ))}
      </ol>
      {!closed && (
        <form className="p-3 border-top cb-border" onSubmit={(e) => void submit(e)}>
          <label htmlFor={`${id}-message`} className="form-label small fw-semibold mb-1">
            {t('coding.assistant.label')}
          </label>
          <textarea
            id={`${id}-message`}
            className={`form-control form-control-sm ${tooLong ? 'is-invalid' : ''}`}
            rows={2}
            value={draft}
            disabled={left === 0}
            aria-describedby={`${id}-left`}
            aria-invalid={tooLong ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-2">
            <span
              id={`${id}-left`}
              className={`small ${tooLong ? 'text-danger' : 'cb-text-secondary'}`}
            >
              {tooLong
                ? t('coding.assistant.tooLong', { max: AI_ASSIST_LIMITS.maxMessageChars })
                : t('coding.assistant.left', { count: left, max: state.maxTurns })}
            </span>
            <button type="submit" className="btn btn-sm btn-outline-primary" disabled={!canSend}>
              {busy ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                  {t('coding.assistant.thinking')}
                </>
              ) : (
                <>
                  <i className="bi bi-send me-1" aria-hidden="true" />
                  {t('coding.assistant.send')}
                </>
              )}
            </button>
          </div>
          {problem && (
            <p className="small text-danger mb-0 mt-2" role="alert">
              {t(`coding.assistant.problems.${problem}`)}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
