import type { InterviewState, ReadinessBand, ReviewFlag } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

const STATE_BADGE: Partial<Record<InterviewState, string>> = {
  REPORT_READY: 'text-bg-success',
  PROCESSING: 'text-bg-info',
  COMPLETING: 'text-bg-info',
  ACTIVE: 'text-bg-primary',
  FAILED: 'text-bg-danger',
  EXPIRED: 'text-bg-secondary',
  CANCELLED: 'text-bg-secondary',
};

export function InterviewStateBadge({ state }: { state: InterviewState }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${STATE_BADGE[state] ?? 'text-bg-light border'}`}>
      {t(`review.states.${state}`)}
    </span>
  );
}

export function BandLabel({ band }: { band: ReadinessBand | null }) {
  const { t } = useTranslation();
  return <>{band ? t(`review.bands.${band}`) : '—'}</>;
}

export function FlagBadge({ flag }: { flag: ReviewFlag }) {
  const { t } = useTranslation();
  if (!flag.flagged) return null;
  return (
    <span className="badge text-bg-danger" title={flag.reason ?? undefined}>
      <i className="bi bi-flag-fill me-1" aria-hidden="true" />
      {t('review.flagged')}
    </span>
  );
}
