import {
  ReviseScoreBody,
  type AdminInterviewDetail,
  type ScoreRevisionSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { campaignError } from '../campaigns/format';
import { FieldError } from '../payments/shared';
import { reviewKeys } from './queries';

type Row = { score: string; note: string };
type Errors = { rows: Record<string, { score?: string; note?: string }>; reason?: string };

const scoreText = (score: number | null) => (score === null ? '' : String(score));

/** '' is "no score"; anything but a whole number from 0 to 100 is NaN. */
function parseScore(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^\d{1,3}$/.test(trimmed) && Number(trimmed) <= 100 ? Number(trimmed) : Number.NaN;
}

/**
 * Revises dimension scores from the latest revision. Only changed dimensions
 * are sent, each with its own note; the server writes a new score and report
 * revision and never modifies earlier ones.
 */
export function ReviseScoreForm({
  interview,
  latest,
  onDone,
}: {
  interview: AdminInterviewDetail;
  latest: ScoreRevisionSummary;
  onDone: (created: ScoreRevisionSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      latest.dimensions.map((d) => [d.key, { score: scoreText(d.score), note: '' }]),
    ),
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({ rows: {} });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isChanged = (key: string, original: number | null) => {
    const value = rows[key]?.score ?? '';
    return value.trim() !== scoreText(original);
  };
  const update = (key: string, patch: Partial<Row>) =>
    setRows((current) => ({ ...current, [key]: { ...current[key]!, ...patch } }));

  const submit = async () => {
    setFormError(null);
    const next: Errors = { rows: {} };
    const changed = latest.dimensions.filter((d) => isChanged(d.key, d.score));
    for (const d of changed) {
      const row = rows[d.key]!;
      const rowErrors: { score?: string; note?: string } = {};
      if (Number.isNaN(parseScore(row.score))) rowErrors.score = t('review.revise.errors.score');
      const note = row.note.trim();
      if (note.length < 3 || note.length > 500) rowErrors.note = t('review.revise.errors.note');
      if (rowErrors.score || rowErrors.note) next.rows[d.key] = rowErrors;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 3 || trimmedReason.length > 500) {
      next.reason = t('review.revise.errors.reason');
    }
    setErrors(next);
    if (changed.length === 0) {
      setFormError(t('review.revise.errors.nothingChanged'));
      return;
    }
    if (Object.keys(next.rows).length > 0 || next.reason) return;

    const body = ReviseScoreBody.parse({
      dimensions: changed.map((d) => ({
        key: d.key,
        score: parseScore(rows[d.key]!.score),
        note: rows[d.key]!.note.trim(),
      })),
      reason: trimmedReason,
    });
    setSubmitting(true);
    try {
      const created = await manager.api.post<ScoreRevisionSummary>(
        `/admin/interviews/${interview.id}/revise-score`,
        body,
      );
      await queryClient.invalidateQueries({ queryKey: reviewKeys.interview(interview.id) });
      await queryClient.invalidateQueries({ queryKey: reviewKeys.interviews });
      onDone(created);
    } catch (err) {
      setFormError(campaignError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      noValidate
      className="p-3 cb-surface-muted rounded-2"
      aria-labelledby={`${id}-heading`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id={`${id}-heading`} className="h6">
        {t('review.revise.title', { n: latest.revision })}
      </h3>
      <p className="small cb-text-secondary">{t('review.revise.hint')}</p>
      <div className="table-responsive">
        <table className="table table-sm align-top small">
          <thead>
            <tr>
              <th scope="col">{t('review.revise.dimension')}</th>
              <th scope="col" className="text-end">
                {t('review.revise.current')}
              </th>
              <th scope="col">{t('review.revise.newScore')}</th>
              <th scope="col">{t('review.revise.note')}</th>
            </tr>
          </thead>
          <tbody>
            {latest.dimensions.map((d) => {
              const row = rows[d.key]!;
              const rowErrors = errors.rows[d.key] ?? {};
              const changed = isChanged(d.key, d.score);
              const scoreId = `${id}-${d.key}-score`;
              const noteId = `${id}-${d.key}-note`;
              return (
                <tr key={d.key} className={changed ? 'table-warning' : undefined}>
                  <th scope="row" className="fw-normal">
                    {d.name}
                    <div>
                      <code>{d.key}</code>
                    </div>
                  </th>
                  <td className="text-end">{d.score ?? '—'}</td>
                  <td style={{ minWidth: '7rem' }}>
                    <label htmlFor={scoreId} className="visually-hidden">
                      {t('review.revise.scoreLabel', { name: d.name })}
                    </label>
                    <input
                      id={scoreId}
                      inputMode="numeric"
                      className={`form-control form-control-sm ${rowErrors.score ? 'is-invalid' : ''}`}
                      value={row.score}
                      aria-invalid={rowErrors.score ? true : undefined}
                      aria-describedby={rowErrors.score ? `${scoreId}-error` : undefined}
                      onChange={(e) => update(d.key, { score: e.target.value })}
                    />
                    <FieldError id={`${scoreId}-error`} message={rowErrors.score} />
                  </td>
                  <td style={{ minWidth: '14rem' }}>
                    <label htmlFor={noteId} className="visually-hidden">
                      {t('review.revise.noteLabel', { name: d.name })}
                    </label>
                    <input
                      id={noteId}
                      className={`form-control form-control-sm ${rowErrors.note ? 'is-invalid' : ''}`}
                      value={row.note}
                      maxLength={500}
                      disabled={!changed}
                      placeholder={changed ? '' : t('review.revise.noteUnchanged')}
                      aria-invalid={rowErrors.note ? true : undefined}
                      aria-describedby={rowErrors.note ? `${noteId}-error` : undefined}
                      onChange={(e) => update(d.key, { note: e.target.value })}
                    />
                    <FieldError id={`${noteId}-error`} message={rowErrors.note} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label htmlFor={`${id}-reason`} className="form-label small">
        {t('review.revise.reason')}
      </label>
      <input
        id={`${id}-reason`}
        className={`form-control form-control-sm mb-2 ${errors.reason ? 'is-invalid' : ''}`}
        value={reason}
        maxLength={500}
        aria-invalid={errors.reason ? true : undefined}
        aria-describedby={errors.reason ? `${id}-reason-error` : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <FieldError id={`${id}-reason-error`} message={errors.reason} />
      <div className="mt-2">
        <ErrorAlert error={formError} />
      </div>
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={submitting}>
          {t('review.revise.submit')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => onDone(null)}
        >
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}
