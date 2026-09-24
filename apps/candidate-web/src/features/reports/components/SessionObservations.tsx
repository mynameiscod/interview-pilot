import type { IntegrityEventType, IntegritySummary } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

/** What is listed (returns to the page are covered by the time away). */
const SHOWN: readonly IntegrityEventType[] = [
  'TAB_HIDDEN',
  'WINDOW_BLUR',
  'PASTE',
  'FULLSCREEN_EXIT',
  'CAMERA_LOST',
  'MICROPHONE_LOST',
];

/**
 * Browser observations noted during the interview, in neutral words. They
 * have ordinary explanations and are not part of the score, so nothing here
 * is styled as a warning.
 */
export function SessionObservations({ integrity }: { integrity: IntegritySummary }) {
  const { t, i18n } = useTranslation();
  const rows = SHOWN.map((type) => ({ type, count: integrity.counts[type] ?? 0 })).filter(
    (row) => row.count > 0,
  );
  const number = (n: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(n);
  const away =
    integrity.awaySec < 60
      ? t('report.observations.seconds', {
          count: integrity.awaySec,
          formatted: number(integrity.awaySec),
        })
      : t('interview.minutes', { count: Math.round(integrity.awaySec / 60) });

  return (
    <section
      className="p-4 border cb-border rounded-3 bg-white"
      aria-labelledby="observations-title"
    >
      <h2 id="observations-title" className="h5">
        <i className="bi bi-eye me-2 text-secondary" aria-hidden="true" />
        {t('report.observations.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="mb-2">{t('report.observations.none')}</p>
      ) : (
        <ul className="mb-2">
          {rows.map((row) => (
            <li key={row.type}>
              {t(`report.observations.types.${row.type}`)}
              <span className="cb-text-secondary">
                {' '}
                ·{' '}
                {t('report.observations.times', { count: row.count, formatted: number(row.count) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {integrity.awaySec > 0 && <p className="mb-2">{t('report.observations.away', { away })}</p>}
      <p className="small cb-text-secondary mb-0">{integrity.note}</p>
    </section>
  );
}
