import { STAR_PARTS, type StarCoverage } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

/**
 * Situation, Task, Action, Result as four segments. Coverage is shown by
 * fill, an icon and (for screen readers) words, never by colour alone.
 */
export function StarBar({
  star,
  estimated = false,
}: {
  star: StarCoverage;
  /** Coverage came from the wording heuristic, not the coaching model. */
  estimated?: boolean;
}) {
  const { t } = useTranslation();
  const parts = STAR_PARTS.map((part) => ({
    part,
    name: t(`report.star.parts.${part}`),
    covered: star[part],
  }));
  return (
    <div>
      <p className="small fw-semibold mb-1">{t('report.star.title')}</p>
      <ul
        className="list-unstyled d-flex gap-1 mb-1"
        aria-label={t('report.star.title')}
        data-testid="star-bar"
      >
        {parts.map(({ part, name, covered }) => (
          <li
            key={part}
            className={`flex-fill text-center rounded small py-1 px-1 ${
              covered ? 'text-bg-success' : 'cb-surface-muted cb-text-secondary border cb-border'
            }`}
          >
            <i className={`bi ${covered ? 'bi-check-lg' : 'bi-dash'} me-1`} aria-hidden="true" />
            <span className="d-sm-none" aria-hidden="true">
              {t(`report.star.short.${part}`)}
            </span>
            <span className="d-none d-sm-inline" aria-hidden="true">
              {name}
            </span>
            <span className="visually-hidden">
              {t(covered ? 'report.star.covered' : 'report.star.missing', { part: name })}
            </span>
          </li>
        ))}
      </ul>
      {estimated && <p className="small cb-text-secondary mb-0">{t('report.star.estimated')}</p>}
    </div>
  );
}
