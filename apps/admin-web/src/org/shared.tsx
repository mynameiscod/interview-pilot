import type { CandidateStage, InviteStatus, OrgResultRow } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

const STAGE_BADGE: Record<CandidateStage, string> = {
  NEW: 'text-bg-light border cb-border',
  SHORTLISTED: 'text-bg-primary',
  ON_HOLD: 'text-bg-warning',
  REJECTED: 'text-bg-secondary',
  HIRED: 'text-bg-success',
};

const INVITE_BADGE: Record<InviteStatus, string> = {
  PENDING: 'text-bg-light border cb-border',
  SENT: 'text-bg-info',
  OPENED: 'text-bg-primary',
  JOINED: 'text-bg-warning',
  COMPLETED: 'text-bg-success',
  FAILED: 'text-bg-danger',
  REVOKED: 'text-bg-secondary',
};

const IDENTITY_BADGE: Record<OrgResultRow['identity'], string> = {
  NONE: 'text-bg-light border cb-border',
  CAPTURED: 'text-bg-info',
  VERIFIED: 'text-bg-success',
  MISMATCH: 'text-bg-danger',
};

export function StageBadge({ stage }: { stage: CandidateStage }) {
  const { t } = useTranslation();
  return <span className={`badge ${STAGE_BADGE[stage]}`}>{t(`orgPortal.stages.${stage}`)}</span>;
}

export function InviteStatusBadge({ status }: { status: InviteStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${INVITE_BADGE[status]}`}>{t(`orgPortal.inviteStatus.${status}`)}</span>
  );
}

export function IdentityBadge({ status }: { status: OrgResultRow['identity'] }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${IDENTITY_BADGE[status]}`}>{t(`orgPortal.identity.${status}`)}</span>
  );
}

/** A secret shown once (webhook signing secret, API key), with a copy button. */
export function ShownOnce({
  label,
  value,
  onDismiss,
}: {
  label: string;
  value: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="alert alert-warning" role="status">
      <p className="small fw-semibold mb-2">{t('orgPortal.shownOnce')}</p>
      <label className="form-label small" htmlFor="shown-once-value">
        {label}
      </label>
      <div className="input-group input-group-sm mb-2">
        <input
          id="shown-once-value"
          className="form-control font-monospace"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void navigator.clipboard?.writeText(value).catch(() => undefined)}
        >
          <i className="bi bi-clipboard me-1" aria-hidden="true" />
          {t('campaigns.invite.copy')}
        </button>
      </div>
      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onDismiss}>
        {t('campaigns.invite.dismiss')}
      </button>
    </div>
  );
}
