import type { FeedbackSummary } from '@cbi/shared-types';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../../interviews/messages';
import { FEEDBACK_ANCHOR, useFeedback, useSaveFeedback } from '../reports-api';

const RATINGS = ['usefulness', 'accuracy', 'interviewQuality'] as const;
type RatingKey = (typeof RATINGS)[number];
type Ratings = Record<RatingKey, number | null>;

const MAX_TEXT = 2000;

function RatingGroup({
  name,
  value,
  onChange,
}: {
  name: RatingKey;
  value: number | null;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <fieldset className="mb-3">
      <legend className="fs-6 fw-semibold mb-1">{t(`report.feedback.${name}`)}</legend>
      <p id={`${id}-hint`} className="small cb-text-secondary mb-1">
        {t('report.feedback.scaleHint')}
      </p>
      <div className="d-flex flex-wrap gap-3" aria-describedby={`${id}-hint`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="form-check form-check-inline me-0">
            <input
              className="form-check-input"
              type="radio"
              id={`${id}-${n}`}
              name={`${id}-${name}`}
              checked={value === n}
              onChange={() => onChange(n)}
            />
            <label className="form-check-label" htmlFor={`${id}-${n}`}>
              {n}
            </label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function FeedbackForm({ sessionId, saved }: { sessionId: string; saved: FeedbackSummary | null }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const save = useSaveFeedback(sessionId);
  const [ratings, setRatings] = useState<Ratings>({
    usefulness: saved?.ratings.usefulness ?? null,
    accuracy: saved?.ratings.accuracy ?? null,
    interviewQuality: saved?.ratings.interviewQuality ?? null,
  });
  const [freeText, setFreeText] = useState(saved?.freeText ?? '');
  const [retake, setRetake] = useState<boolean | null>(saved?.intendsRetake ?? null);
  const [missing, setMissing] = useState(false);
  const thanked = Boolean(saved) || save.isSuccess;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const { usefulness, accuracy, interviewQuality } = ratings;
    if (usefulness === null || accuracy === null || interviewQuality === null) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const text = freeText.trim();
    await save
      .mutateAsync({
        sessionId,
        ratings: { usefulness, accuracy, interviewQuality },
        freeText: text ? text : null,
        intendsRetake: retake,
      })
      .catch(() => undefined);
  }

  const numberFormat = new Intl.NumberFormat(i18n.resolvedLanguage);
  return (
    <form onSubmit={onSubmit} noValidate>
      {RATINGS.map((key) => (
        <RatingGroup
          key={key}
          name={key}
          value={ratings[key]}
          onChange={(v) => setRatings((r) => ({ ...r, [key]: v }))}
        />
      ))}
      <fieldset className="mb-3">
        <legend className="fs-6 fw-semibold mb-1">{t('report.feedback.retake')}</legend>
        {(
          [
            ['yes', true],
            ['no', false],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="form-check form-check-inline">
            <input
              className="form-check-input"
              type="radio"
              id={`${id}-retake-${label}`}
              name={`${id}-retake`}
              checked={retake === value}
              onChange={() => setRetake(value)}
            />
            <label className="form-check-label" htmlFor={`${id}-retake-${label}`}>
              {t(`report.feedback.${label}`)}
            </label>
          </div>
        ))}
      </fieldset>
      <div className="mb-3">
        <label htmlFor={`${id}-text`} className="form-label fw-semibold">
          {t('report.feedback.freeText')}
        </label>
        <textarea
          id={`${id}-text`}
          className="form-control"
          rows={3}
          maxLength={MAX_TEXT}
          value={freeText}
          aria-describedby={`${id}-count`}
          onChange={(e) => setFreeText(e.target.value)}
        />
        <p id={`${id}-count`} className="small cb-text-secondary mb-0 mt-1">
          {t('report.feedback.charCount', {
            count: freeText.length,
            formatted: numberFormat.format(freeText.length),
            max: numberFormat.format(MAX_TEXT),
          })}
        </p>
      </div>
      {missing && (
        <div className="alert alert-warning" role="alert">
          {t('report.feedback.missing')}
        </div>
      )}
      {save.isError && (
        <div className="alert alert-danger" role="alert">
          {inputErrorMessage(t, save.error)}
        </div>
      )}
      <div aria-live="polite">
        {thanked && !save.isPending && (
          <p className="text-success mb-3" role="status">
            <i className="bi bi-check-circle-fill me-1" aria-hidden="true" />
            {t('report.feedback.thanks')}
          </p>
        )}
      </div>
      <button type="submit" className="btn btn-primary" disabled={save.isPending}>
        {save.isPending
          ? t('report.feedback.sending')
          : thanked
            ? t('report.feedback.update')
            : t('report.feedback.submit')}
      </button>
    </form>
  );
}

/** Screen 35: "Rate this report", reachable as the report's feedback anchor. */
export function FeedbackCard({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const feedback = useFeedback(sessionId);
  return (
    <section
      id={FEEDBACK_ANCHOR}
      className="p-4 border cb-border rounded-3 bg-white"
      aria-labelledby="feedback-title"
      tabIndex={-1}
    >
      <h2 id="feedback-title" className="h5">
        {t('report.feedback.title')}
      </h2>
      <p className="cb-text-secondary">{t('report.feedback.intro')}</p>
      {feedback.isPending ? (
        <p className="cb-text-secondary mb-0">{t('common.loading')}</p>
      ) : (
        <FeedbackForm sessionId={sessionId} saved={feedback.data ?? null} />
      )}
    </section>
  );
}
