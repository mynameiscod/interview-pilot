import type { InterviewSummary } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

type Campaign = NonNullable<InterviewSummary['campaign']>;

/** Shown on a campaign interview's screens: who invited the candidate, and who pays. */
export function CampaignBanner({ campaign }: { campaign: Campaign | null }) {
  const { t } = useTranslation();
  if (!campaign) return null;
  return (
    <aside
      className="p-3 mb-4 rounded-3 border cb-border cb-surface-muted d-flex flex-wrap align-items-center gap-2"
      aria-label={t('campaign.banner.label')}
    >
      <i className="bi bi-building text-secondary" aria-hidden="true" />
      <span className="flex-grow-1">
        <span className="fw-semibold">
          {t('campaign.banner.invitedBy', { company: campaign.companyName })}
        </span>
        <span className="cb-text-secondary"> · {campaign.name}</span>
      </span>
      {campaign.sponsored && (
        <span className="badge text-bg-success fw-normal">{t('campaign.sponsoredBadge')}</span>
      )}
    </aside>
  );
}
