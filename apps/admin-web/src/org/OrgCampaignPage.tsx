import type { CampaignSummary, CampaignWithInvite } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { consoleError } from '../features/ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../features/ai/shared';
import { campaignError, STATUS_MOVES } from '../features/campaigns/format';
import { CampaignStatusBadge, InviteLinkPanel } from '../features/campaigns/shared';
import { formatDateTime } from '../features/library/format';
import { OrgCandidatesSection } from './OrgCandidatesSection';
import { OrgInvitesSection } from './OrgInvitesSection';
import { orgKeys, useOrgCampaign } from './queries';
import { useOrgAuth, useOrgCan } from './session';

const TABS = ['candidates', 'invites', 'settings'] as const;
type Tab = (typeof TABS)[number];

function SettingsSection({ campaign }: { campaign: CampaignSummary }) {
  const { t, i18n } = useTranslation();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const canManage = useOrgCan('org.campaigns.manage');
  const [action, setAction] = useState<'ACTIVE' | 'PAUSED' | 'CLOSED' | 'rotate' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<CampaignWithInvite | null>(null);

  async function run(reason: string) {
    setPending(true);
    setError(null);
    try {
      if (action === 'rotate') {
        setRotated(
          await manager.api.post<CampaignWithInvite>(
            `/org/campaigns/${campaign.id}/rotate-invite`,
            { reason },
          ),
        );
      } else {
        await manager.api.post(`/org/campaigns/${campaign.id}/status`, { status: action, reason });
      }
      setAction(null);
      await queryClient.invalidateQueries({ queryKey: orgKeys.all });
    } catch (err) {
      setError(campaignError(t, err));
    } finally {
      setPending(false);
    }
  }

  const facts: [string, string][] = [
    [t('campaigns.fields.role'), campaign.role.title],
    [t('orgPortal.campaigns.template'), campaign.template.name],
    [t('campaigns.fields.startAt'), formatDateTime(campaign.window.startAt, i18n.language)],
    [
      t('campaigns.fields.endAt'),
      campaign.window.endAt ? formatDateTime(campaign.window.endAt, i18n.language) : '—',
    ],
    [
      t('orgPortal.campaigns.sponsoredCredits'),
      campaign.sponsoredCredits
        ? t('orgPortal.campaigns.sponsoredUsed', campaign.sponsoredCredits)
        : '—',
    ],
    [t('orgPortal.campaigns.employerView'), t(`orgPortal.employerView.${campaign.employerView}`)],
    [
      t('orgPortal.campaigns.requireInvite'),
      campaign.requireInvite ? t('orgPortal.yes') : t('orgPortal.no'),
    ],
    [
      t('orgPortal.campaigns.idCapture'),
      campaign.idCapture ? t('orgPortal.yes') : t('orgPortal.no'),
    ],
  ];

  return (
    <section aria-labelledby="org-campaign-settings">
      <h2 id="org-campaign-settings" className="h5">
        {t('orgPortal.campaign.settings')}
      </h2>
      <dl className="row small">
        {facts.map(([label, value]) => (
          <div className="col-md-6 d-flex gap-2" key={label}>
            <dt className="fw-normal cb-text-secondary">{label}</dt>
            <dd className="mb-1">{value}</dd>
          </div>
        ))}
      </dl>
      {rotated && (
        <InviteLinkPanel
          invitePath={rotated.invitePath}
          campaignName={rotated.campaign.name}
          onDismiss={() => setRotated(null)}
        />
      )}
      {canManage && (
        <div className="d-flex flex-wrap gap-2 mb-2">
          {STATUS_MOVES[campaign.status].map((to) => (
            <button
              key={to}
              type="button"
              className={`btn btn-sm ${to === 'CLOSED' ? 'btn-outline-danger' : 'btn-outline-primary'}`}
              onClick={() => setAction(to)}
            >
              {t(`orgPortal.campaign.moveTo.${to}`)}
            </button>
          ))}
          {campaign.status !== 'CLOSED' && (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setAction('rotate')}
            >
              {t('orgPortal.campaign.rotate')}
            </button>
          )}
        </div>
      )}
      {action && (
        <ReasonForm
          submitLabel={
            action === 'rotate'
              ? t('orgPortal.campaign.rotate')
              : t(`orgPortal.campaign.moveTo.${action}`)
          }
          danger={action === 'CLOSED'}
          pending={pending}
          error={error}
          onSubmit={(reason) => void run(reason)}
          onCancel={() => setAction(null)}
        >
          {action === 'CLOSED' && <p className="small">{t('orgPortal.campaign.closeWarning')}</p>}
        </ReasonForm>
      )}
    </section>
  );
}

export function OrgCampaignPage() {
  const { t } = useTranslation();
  const { campaignId = '' } = useParams();
  const { user } = useOrgAuth();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'candidates';
  const campaign = useOrgCampaign(campaignId);

  if (campaign.isPending) return <LoadingRow />;
  if (campaign.isError) return <ErrorAlert error={consoleError(t, campaign.error)} />;
  const c = campaign.data;

  return (
    <>
      <nav aria-label={t('orgPortal.breadcrumb')} className="small mb-2">
        <Link to="/org">{t('orgPortal.nav.campaigns')}</Link>
      </nav>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">{c.name}</h1>
        <CampaignStatusBadge status={c.status} />
        <span className="small cb-text-secondary">
          {t('orgPortal.campaign.joined', { count: c.joined })}
        </span>
      </div>
      <ul className="nav nav-tabs mb-3" role="tablist">
        {TABS.map((key) => (
          <li className="nav-item" role="presentation" key={key}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`nav-link ${tab === key ? 'active' : ''}`}
              onClick={() => setParams(key === 'candidates' ? {} : { tab: key }, { replace: true })}
            >
              {t(`orgPortal.campaign.tabs.${key}`)}
            </button>
          </li>
        ))}
      </ul>
      <div role="tabpanel">
        {tab === 'candidates' && <OrgCandidatesSection campaign={c} />}
        {tab === 'invites' && (
          <OrgInvitesSection campaign={c} college={user?.org.type === 'COLLEGE'} />
        )}
        {tab === 'settings' && <SettingsSection campaign={c} />}
      </div>
    </>
  );
}
