import type { AdminInterviewDetail } from '@cbi/shared-types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../library/format';

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Coding submissions very similar to another candidate's in the same
 * campaign. An observation for the reviewer to check, never a score.
 */
export function SimilarCode({ interview }: { interview: AdminInterviewDetail }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const flags = interview.codeSimilarity ?? [];
  if (flags.length === 0) return null;
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        <i className="bi bi-files me-1" aria-hidden="true" />
        {t('review.similarity.title')}
      </h2>
      <p className="small cb-text-secondary">{t('review.similarity.note')}</p>
      <div className="table-responsive">
        <table className="table table-sm align-middle small mb-0">
          <thead>
            <tr>
              <th scope="col">{t('review.similarity.problem')}</th>
              <th scope="col">{t('review.similarity.other')}</th>
              <th scope="col" className="text-end">
                {t('review.similarity.similarity')}
              </th>
              <th scope="col" className="text-end">
                {t('review.similarity.containment')}
              </th>
              <th scope="col">{t('review.similarity.checked')}</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={`${f.otherInterviewId}-${f.problemTitle}`}>
                <td>
                  {f.problemTitle} <span className="cb-text-secondary">({f.language})</span>
                </td>
                <td>
                  <Link to={`/interviews/${f.otherInterviewId}`}>
                    {f.otherCandidateEmail ?? f.otherInterviewId}
                  </Link>
                </td>
                <td className="text-end">{percent(f.similarity)}</td>
                <td className="text-end">{percent(f.containment)}</td>
                <td>{formatDateTime(f.computedAt, i18n.language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The candidate's whole conversation with the coding assistant (AI-allowed rounds). */
export function AssistantTranscripts({ interview }: { interview: AdminInterviewDetail }) {
  const { t } = useTranslation();
  const id = useId();
  const transcripts = interview.assistantTranscripts ?? [];
  if (transcripts.length === 0) return null;
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('review.assistant.title')}
      </h2>
      {transcripts.map((tr, i) => (
        <details key={i} className="mb-2">
          <summary className="small fw-semibold">
            {t('review.assistant.problem', { title: tr.problemTitle, count: tr.messages.length })}
          </summary>
          <ol className="list-unstyled small mt-2 mb-0">
            {tr.messages.map((m, j) => (
              <li key={j} className="mb-2">
                <span className="fw-semibold">
                  {m.role === 'CANDIDATE'
                    ? t('review.assistant.candidate')
                    : t('review.assistant.ai')}
                  :
                </span>{' '}
                {m.unavailable ? (
                  <span className="cb-text-secondary">{t('review.assistant.unavailable')}</span>
                ) : (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                )}
                {m.redacted && (
                  <span className="cb-text-secondary"> {t('review.assistant.redacted')}</span>
                )}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </section>
  );
}
