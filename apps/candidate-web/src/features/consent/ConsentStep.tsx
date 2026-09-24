import type { ConsentType, SessionConsentItem, SessionConsents } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { applyConsents, useConsentApi, useSessionConsents } from './consent-api';

type Choice = 'accept' | 'decline';

const TYPE_ICON = {
  VOICE_PROCESSING: 'bi-soundwave',
  RECORDING: 'bi-record-circle',
  INTEGRITY: 'bi-eye',
  CAMPAIGN_SHARING: 'bi-building',
} as const satisfies Record<ConsentType, string>;

/** Consent texts are plain text; a blank line starts a new paragraph. */
function Paragraphs({ body }: { body: string }) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className="small mb-2" style={{ whiteSpace: 'pre-line' }}>
          {p}
        </p>
      ))}
    </>
  );
}

function initialChoices(items: SessionConsentItem[]): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const item of items) {
    if (item.decision) out[item.text.id] = item.decision.accepted ? 'accept' : 'decline';
  }
  return out;
}

function ConsentItem({
  item,
  choice,
  onChoose,
  disabled,
}: {
  item: SessionConsentItem;
  choice: Choice | undefined;
  onChoose: (choice: Choice) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const recording = item.type === 'RECORDING';
  const labels = {
    accept: recording ? t('consent.recording.accept') : t('consent.accept'),
    decline: recording ? t('consent.recording.decline') : t('consent.decline'),
  };
  return (
    <fieldset className="p-3 border cb-border rounded-3 bg-white mb-0">
      <legend className="h6 float-none w-auto mb-2">
        <i className={`bi ${TYPE_ICON[item.type]} me-2 text-secondary`} aria-hidden="true" />
        {item.text.title}{' '}
        <span className="badge text-bg-light border cb-border fw-normal ms-1">
          {item.required ? t('consent.required') : t('consent.optional')}
        </span>
      </legend>
      <Paragraphs body={item.text.body} />
      {recording && !item.required && (
        <p className="small cb-text-secondary mb-2">{t('consent.recording.optionalHint')}</p>
      )}
      <div className="d-flex flex-wrap gap-3 mt-2">
        {(['accept', 'decline'] as const).map((value) => (
          <div key={value} className="form-check">
            <input
              id={`${id}-${value}`}
              type="radio"
              className="form-check-input"
              name={`${id}-choice`}
              checked={choice === value}
              disabled={disabled}
              onChange={() => onChoose(value)}
            />
            <label htmlFor={`${id}-${value}`} className="form-check-label">
              {labels[value]}
            </label>
          </div>
        ))}
      </div>
      {item.required && choice === 'decline' && (
        <p className="small mb-0 mt-2">
          <i className="bi bi-info-circle me-1" aria-hidden="true" />
          {t('consent.requiredDeclined')}
        </p>
      )}
    </fieldset>
  );
}

function ConsentForm({
  sessionId,
  consents,
  onDone,
}: {
  sessionId: string;
  consents: SessionConsents;
  onDone: (consents: SessionConsents) => void;
}) {
  const { t } = useTranslation();
  const api = useConsentApi();
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState(() => initialChoices(consents.items));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const blockedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (blocked) blockedRef.current?.focus();
  }, [blocked]);

  const allChosen = consents.items.every((item) => choices[item.text.id]);

  async function save() {
    if (!allChosen) return;
    setSaving(true);
    setError(null);
    setBlocked(false);
    try {
      const saved = await api.decide(
        sessionId,
        consents.items.map((item) => ({
          consentTextId: item.text.id,
          accepted: choices[item.text.id] === 'accept',
        })),
      );
      applyConsents(queryClient, sessionId, saved);
      if (saved.complete) {
        onDone(saved);
        return;
      }
      setBlocked(true);
    } catch (err) {
      setError(inputErrorMessage(t, err));
    }
    setSaving(false);
  }

  if (consents.items.length === 0) {
    return (
      <div>
        <p>{t('consent.nothingNeeded')}</p>
        <button type="button" className="btn btn-primary" onClick={() => onDone(consents)}>
          {t('consent.continue')}
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="d-flex flex-column gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {consents.items.map((item) => (
        <ConsentItem
          key={item.text.id}
          item={item}
          choice={choices[item.text.id]}
          disabled={saving}
          onChoose={(choice) => {
            setBlocked(false);
            setChoices((c) => ({ ...c, [item.text.id]: choice }));
          }}
        />
      ))}
      {blocked && (
        <div ref={blockedRef} tabIndex={-1} className="alert alert-warning mb-0" role="alert">
          {t('consent.blocked')}
        </div>
      )}
      {error && (
        <div className="alert alert-danger mb-0" role="alert">
          {error}
        </div>
      )}
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!allChosen || saving}>
          {saving ? t('consent.saving') : t('consent.save')}
        </button>
        {!allChosen && <span className="small cb-text-secondary">{t('consent.chooseAll')}</span>}
      </div>
    </form>
  );
}

/**
 * The consents an interview asks for (voice processing, recording, session
 * observations), each with its current text. Required ones must be accepted
 * to start; declining optional recording runs the interview unrecorded.
 * Shared by the voice/video device check and the text interview flow.
 */
export function ConsentStep({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: (consents: SessionConsents) => void;
}) {
  const { t } = useTranslation();
  const consents = useSessionConsents(sessionId);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => headingRef.current?.focus(), []);

  return (
    <section
      className="p-4 border cb-border rounded-3 cb-surface-muted"
      aria-labelledby="consent-title"
    >
      <h2 id="consent-title" ref={headingRef} tabIndex={-1} className="h5">
        <i className="bi bi-shield-lock me-2 text-secondary" aria-hidden="true" />
        {t('consent.title')}
      </h2>
      <p>{t('consent.intro')}</p>
      {consents.isPending && <p className="cb-text-secondary mb-0">{t('common.loading')}</p>}
      {consents.isError && (
        <div className="alert alert-danger mb-0" role="alert">
          <p className="mb-2">{inputErrorMessage(t, consents.error)}</p>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            onClick={() => void consents.refetch()}
          >
            {t('consent.retry')}
          </button>
        </div>
      )}
      {consents.data && (
        <ConsentForm sessionId={sessionId} consents={consents.data} onDone={onDone} />
      )}
    </section>
  );
}
