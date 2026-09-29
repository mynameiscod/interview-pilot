import type { BadgeKey, BadgeState } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../interviews/messages';

const BADGE_ICON: Record<BadgeKey, string> = {
  FIRST_INTERVIEW: 'bi-flag',
  FIRST_VOICE_INTERVIEW: 'bi-mic',
  STREAK_3: 'bi-fire',
  STREAK_7: 'bi-calendar-week',
  READINESS_PLUS_10: 'bi-graph-up-arrow',
  PLAN_COMPLETE: 'bi-check2-all',
  CODING_PASSED: 'bi-terminal',
};

/** Milestones earned (and the ones still ahead), each with what it takes. */
export function BadgesCard({ badges }: { badges: readonly BadgeState[] }) {
  const { t, i18n } = useTranslation();
  const earned = badges.filter((b) => b.earned).length;
  return (
    <section className="cb-dash-card" aria-labelledby="badges-title">
      <div className="d-flex flex-wrap align-items-baseline justify-content-between gap-2 mb-2">
        <h2 id="badges-title" className="h5 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-award text-secondary" aria-hidden="true" />
          {t('progress.badges.title')}
        </h2>
        <span className="small cb-text-secondary">
          {t('progress.badges.count', { earned, total: badges.length })}
        </span>
      </div>
      <ul className="row row-cols-1 row-cols-sm-2 g-2 list-unstyled mb-0">
        {badges.map((b) => (
          <li key={b.key} className="col">
            <div className={`cb-badge-tile h-100 ${b.earned ? '' : 'cb-badge-tile--locked'}`}>
              <span
                className={`cb-icon-tile cb-icon-tile--sm cb-icon-tile--round ${b.earned ? '' : 'cb-icon-tile--muted'}`}
                aria-hidden="true"
              >
                <i className={`bi ${b.earned ? BADGE_ICON[b.key] : 'bi-lock'}`} />
              </span>
              <div>
                <div className="fw-semibold small">{t(`progress.badges.names.${b.key}`)}</div>
                <div className="small cb-text-secondary">
                  {b.earned && b.awardedAt
                    ? t('progress.badges.earnedOn', {
                        date: formatDate(i18n.resolvedLanguage, b.awardedAt),
                      })
                    : t(`progress.badges.how.${b.key}`)}
                </div>
                <span className="visually-hidden">
                  {b.earned ? t('progress.badges.earned') : t('progress.badges.notYet')}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
