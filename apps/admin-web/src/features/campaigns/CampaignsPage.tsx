import type { CampaignWithInvite } from '@cbi/shared-types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { CampaignCreateForm } from './CampaignCreateForm';
import { campaignError } from './format';
import { useCampaigns } from './queries';
import { CampaignStatusBadge, InviteLinkPanel } from './shared';

export function CampaignsPage() {
  const { t, i18n } = useTranslation();
  const canManage = useCan('campaigns.manage');
  const campaigns = useCampaigns();
  const [creating, setCreating] = useState(false);
  // The invite path exists only in the create response, so it lives in memory until dismissed.
  const [created, setCreated] = useState<CampaignWithInvite | null>(null);

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <h1 className="h3 mb-0">{t('campaigns.list.title')}</h1>
        {canManage && !creating && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setCreated(null);
              setCreating(true);
            }}
          >
            <i className="bi bi-plus-lg me-1" aria-hidden="true" />
            {t('campaigns.list.new')}
          </button>
        )}
      </div>
      <p className="cb-text-secondary">{t('campaigns.list.subtitle')}</p>
      {created && (
        <InviteLinkPanel
          invitePath={created.invitePath}
          campaignName={created.campaign.name}
          onDismiss={() => setCreated(null)}
        >
          <Link to={`/campaigns/${created.campaign.id}`} className="btn btn-sm btn-outline-primary">
            {t('campaigns.invite.openCampaign')}
          </Link>
        </InviteLinkPanel>
      )}
      {creating && (
        <CampaignCreateForm
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('campaigns.list.listLabel')}
      >
        {campaigns.isPending && <LoadingRow />}
        {campaigns.isError && (
          <div className="m-3">
            <ErrorAlert error={campaignError(t, campaigns.error)} />
          </div>
        )}
        {campaigns.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('campaigns.fields.name')}</th>
                  <th scope="col">{t('campaigns.fields.companyName')}</th>
                  <th scope="col">{t('campaigns.fields.role')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col" className="text-end">
                    {t('campaigns.list.joined')}
                  </th>
                  <th scope="col">{t('campaigns.list.window')}</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="cb-text-secondary">
                      {t('campaigns.list.empty')}
                    </td>
                  </tr>
                )}
                {campaigns.data.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className="fw-normal">
                      <Link to={`/campaigns/${c.id}`}>{c.name}</Link>
                    </th>
                    <td>{c.companyName}</td>
                    <td>{c.role.title}</td>
                    <td>
                      <CampaignStatusBadge status={c.status} />
                    </td>
                    <td className="text-end">
                      {c.maxCandidates === null
                        ? c.joined
                        : t('campaigns.joinedOf', { joined: c.joined, max: c.maxCandidates })}
                    </td>
                    <td className="small">
                      {formatDateTime(c.window.startAt, i18n.language)}
                      {' – '}
                      {c.window.endAt
                        ? formatDateTime(c.window.endAt, i18n.language)
                        : t('campaigns.noEnd')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
