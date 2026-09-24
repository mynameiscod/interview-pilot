import type { ApplicationStatus, CampaignStatus } from '@cbi/shared-types';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { inviteLink } from './format';

const STATUS_BADGE: Record<CampaignStatus, string> = {
  DRAFT: 'text-bg-info',
  ACTIVE: 'text-bg-success',
  PAUSED: 'text-bg-warning',
  CLOSED: 'text-bg-secondary',
};

const APPLICATION_BADGE: Record<ApplicationStatus, string> = {
  JOINED: 'text-bg-info',
  IN_PROGRESS: 'text-bg-primary',
  COMPLETED: 'text-bg-success',
  DID_NOT_FINISH: 'text-bg-secondary',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${STATUS_BADGE[status]}`}>{t(`campaigns.status.${status}`)}</span>;
}

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${APPLICATION_BADGE[status]}`}>
      {t(`campaigns.applicationStatus.${status}`)}
    </span>
  );
}

/**
 * The invite link, shown once after a campaign is created or its link rotated.
 * Only a hash of the token is stored, so it cannot be shown again later.
 */
export function InviteLinkPanel({
  invitePath,
  campaignName,
  onDismiss,
  children,
}: {
  invitePath: string;
  campaignName: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const { url, full } = inviteLink(invitePath);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <section className="alert alert-warning mb-3" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="h6">
        <i className="bi bi-link-45deg me-1" aria-hidden="true" />
        {t('campaigns.invite.title', { name: campaignName })}
      </h2>
      <p className="small fw-semibold mb-2">{t('campaigns.invite.onceWarning')}</p>
      <label htmlFor={`${id}-url`} className="form-label small">
        {full ? t('campaigns.invite.link') : t('campaigns.invite.path')}
      </label>
      <div className="input-group input-group-sm mb-2">
        <input
          id={`${id}-url`}
          className="form-control font-monospace"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          <i className="bi bi-clipboard me-1" aria-hidden="true" />
          {t('campaigns.invite.copy')}
        </button>
      </div>
      {!full && <p className="small mb-2">{t('campaigns.invite.pathOnly')}</p>}
      <div role="status" aria-live="polite" className="small">
        {copied === 'yes' && t('campaigns.invite.copied')}
        {copied === 'failed' && t('campaigns.invite.copyFailed')}
      </div>
      <div className="d-flex flex-wrap gap-2">
        {children}
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onDismiss}>
          {t('campaigns.invite.dismiss')}
        </button>
      </div>
    </section>
  );
}
