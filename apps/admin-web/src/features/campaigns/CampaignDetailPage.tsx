import type { CampaignSummary, CampaignWithInvite } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { CampaignEditForm } from './CampaignEditForm';
import { CampaignResultsSection } from './CampaignResultsSection';
import { campaignError, STATUS_MOVES } from './format';
import { campaignKeys, useCampaign } from './queries';
import { CampaignStatusBadge, InviteLinkPanel } from './shared';

type Move = 'ACTIVE' | 'PAUSED' | 'CLOSED';
type Pending = { kind: 'status'; to: Move } | { kind: 'rotate' } | null;

function Settings({ campaign }: { campaign: CampaignSummary }) {
  const { t, i18n } = useTranslation();
  const date = (value: string | null) => (value ? formatDateTime(value, i18n.language) : '—');
  const yesNo = (value: boolean) => (value ? t('library.yes') : t('library.no'));
  const canSeeLibrary = useCan('library.read');
  return (
    <div className="row g-3 mb-3">
      <section className="col-lg-6" aria-labelledby="campaign-settings-heading">
        <div className="p-3 border cb-border rounded-3 bg-white h-100">
          <h2 id="campaign-settings-heading" className="h6">
            {t('campaigns.detail.settings')}
          </h2>
          <dl className="row small mb-0">
            <dt className="col-sm-5">{t('campaigns.fields.companyName')}</dt>
            <dd className="col-sm-7">
              {campaign.companyName}
              {campaign.companyId && (
                <div className="cb-text-secondary">{t('campaigns.detail.libraryCompany')}</div>
              )}
            </dd>
            <dt className="col-sm-5">{t('campaigns.fields.modes')}</dt>
            <dd className="col-sm-7">
              {campaign.modes.map((m) => t(`library.modes.${m}`)).join(', ')}
            </dd>
            <dt className="col-sm-5">{t('campaigns.fields.languages')}</dt>
            <dd className="col-sm-7">
              {campaign.languages.map((l) => t(`campaigns.languages.${l}`)).join(', ')}
            </dd>
            <dt className="col-sm-5">{t('campaigns.list.window')}</dt>
            <dd className="col-sm-7">
              {date(campaign.window.startAt)} –{' '}
              {campaign.window.endAt ? date(campaign.window.endAt) : t('campaigns.noEnd')}
            </dd>
            <dt className="col-sm-5">{t('campaigns.fields.recording')}</dt>
            <dd className="col-sm-7">{t(`library.recording.${campaign.proctoring.recording}`)}</dd>
            <dt className="col-sm-5">{t('campaigns.fields.tabSwitchTracking')}</dt>
            <dd className="col-sm-7">{yesNo(campaign.proctoring.tabSwitchTracking)}</dd>
            <dt className="col-sm-5">{t('campaigns.fields.candidateSeesReport')}</dt>
            <dd className="col-sm-7">{yesNo(campaign.candidateSeesReport)}</dd>
            <dt className="col-sm-5">{t('library.created')}</dt>
            <dd className="col-sm-7">{date(campaign.createdAt)}</dd>
            <dt className="col-sm-5">{t('library.updated')}</dt>
            <dd className="col-sm-7 mb-0">{date(campaign.updatedAt)}</dd>
          </dl>
          {campaign.jobDescription && (
            <details className="small mt-2">
              <summary>{t('campaigns.fields.jobDescription')}</summary>
              <p className="mb-0 mt-1" style={{ whiteSpace: 'pre-wrap' }}>
                {campaign.jobDescription}
              </p>
            </details>
          )}
        </div>
      </section>
      <section className="col-lg-6" aria-labelledby="campaign-pinned-heading">
        <div className="p-3 border cb-border rounded-3 bg-white h-100">
          <h2 id="campaign-pinned-heading" className="h6">
            {t('campaigns.detail.pinned')}
          </h2>
          <p className="small cb-text-secondary">{t('campaigns.detail.pinnedHint')}</p>
          <dl className="row small mb-0">
            <dt className="col-sm-5">{t('campaigns.fields.role')}</dt>
            <dd className="col-sm-7">
              {canSeeLibrary ? (
                <Link to={`/roles/${campaign.role.id}`}>{campaign.role.title}</Link>
              ) : (
                campaign.role.title
              )}
            </dd>
            <dt className="col-sm-5">{t('campaigns.detail.blueprint')}</dt>
            <dd className="col-sm-7">{t('library.version', { n: campaign.blueprint.version })}</dd>
            <dt className="col-sm-5">{t('campaigns.fields.template')}</dt>
            <dd className="col-sm-7">
              {campaign.template.name} (<code>{campaign.template.key}</code>,{' '}
              {t('library.version', { n: campaign.template.version })})
            </dd>
            <dt className="col-sm-5">{t('campaigns.list.joined')}</dt>
            <dd className="col-sm-7">
              {campaign.maxCandidates === null
                ? t('campaigns.joinedUnlimited', { joined: campaign.joined })
                : t('campaigns.joinedOf', {
                    joined: campaign.joined,
                    max: campaign.maxCandidates,
                  })}
            </dd>
            <dt className="col-sm-5">{t('campaigns.fields.sponsoredCredits')}</dt>
            <dd className="col-sm-7">
              {campaign.sponsoredCredits === null
                ? t('campaigns.detail.notSponsored')
                : t('campaigns.detail.sponsoredUsed', {
                    used: campaign.sponsoredCredits.used,
                    total: campaign.sponsoredCredits.total,
                  })}
            </dd>
            <dt className="col-sm-5">{t('campaigns.detail.inviteLink')}</dt>
            <dd className="col-sm-7 mb-0">
              {t('campaigns.detail.tokenHint', { hint: campaign.tokenHint })}
            </dd>
          </dl>
        </div>
      </section>
    </div>
  );
}

function Actions({
  campaign,
  onNotice,
  onInvite,
  onEdit,
}: {
  campaign: CampaignSummary;
  onNotice: (text: string) => void;
  onInvite: (result: CampaignWithInvite) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moves = STATUS_MOVES[campaign.status];
  const closed = campaign.status === 'CLOSED';

  const reset = () => {
    setPending(null);
    setConfirmed(false);
    setError(null);
  };
  const updated = async (next: CampaignSummary) => {
    queryClient.setQueryData(campaignKeys.campaign(campaign.id), next);
    await queryClient.invalidateQueries({ queryKey: campaignKeys.list });
  };

  const setStatus = useMutation({
    mutationFn: ({ to, reason }: { to: Move; reason: string }) =>
      manager.api.post<CampaignSummary>(`/admin/campaigns/${campaign.id}/status`, {
        status: to,
        reason,
      }),
    onSuccess: async (next) => {
      reset();
      await updated(next);
      onNotice(t('campaigns.statusChange.done', { status: t(`campaigns.status.${next.status}`) }));
    },
    onError: (err) => setError(campaignError(t, err)),
  });

  const rotate = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<CampaignWithInvite>(`/admin/campaigns/${campaign.id}/rotate-invite`, {
        reason,
      }),
    onSuccess: async (result) => {
      reset();
      await updated(result.campaign);
      onInvite(result);
    },
    onError: (err) => setError(campaignError(t, err)),
  });

  const moveLabel = (to: Move) =>
    to === 'ACTIVE' && campaign.status === 'PAUSED'
      ? t('campaigns.statusChange.resume')
      : t(`campaigns.statusChange.to.${to}`);

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('campaigns.detail.actions')}
      </h2>
      {closed && <p className="small cb-text-secondary mb-0">{t('campaigns.detail.closed')}</p>}
      {!closed && pending === null && (
        <div className="d-flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={onEdit}>
            {t('campaigns.edit.button')}
          </button>
          {moves.map((to) => (
            <button
              key={to}
              type="button"
              className={`btn btn-sm ${to === 'CLOSED' ? 'btn-outline-danger' : 'btn-outline-primary'}`}
              onClick={() => {
                reset();
                setPending({ kind: 'status', to });
              }}
            >
              {moveLabel(to)}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-outline-warning"
            onClick={() => {
              reset();
              setPending({ kind: 'rotate' });
            }}
          >
            {t('campaigns.rotate.button')}
          </button>
        </div>
      )}
      {pending?.kind === 'status' && (
        <ReasonForm
          submitLabel={
            pending.to === 'CLOSED'
              ? t('campaigns.statusChange.confirmClose')
              : moveLabel(pending.to)
          }
          danger={pending.to === 'CLOSED'}
          pending={setStatus.isPending}
          disabled={pending.to === 'CLOSED' && !confirmed}
          error={error}
          onSubmit={(reason) => setStatus.mutate({ to: pending.to, reason })}
          onCancel={reset}
        >
          <p className="fw-semibold mb-1">{t(`campaigns.statusChange.explain.${pending.to}`)}</p>
          {pending.to === 'CLOSED' && (
            <div className="form-check mb-2">
              <input
                id={`${id}-confirm-close`}
                type="checkbox"
                className="form-check-input"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <label htmlFor={`${id}-confirm-close`} className="form-check-label">
                {t('campaigns.statusChange.acknowledgeClose')}
              </label>
            </div>
          )}
        </ReasonForm>
      )}
      {pending?.kind === 'rotate' && (
        <ReasonForm
          submitLabel={t('campaigns.rotate.confirm')}
          danger
          pending={rotate.isPending}
          error={error}
          onSubmit={(reason) => rotate.mutate(reason)}
          onCancel={reset}
        >
          <p className="fw-semibold mb-1">{t('campaigns.rotate.title')}</p>
          <p className="small">{t('campaigns.rotate.explain')}</p>
        </ReasonForm>
      )}
    </section>
  );
}

export function CampaignDetailPage() {
  const { t } = useTranslation();
  const { campaignId = '' } = useParams();
  const canManage = useCan('campaigns.manage');
  const campaign = useCampaign(campaignId);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState<CampaignWithInvite | null>(null);
  const [editing, setEditing] = useState(false);

  return (
    <>
      <p className="mb-2">
        <Link to="/campaigns" className="small">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          {t('campaigns.detail.back')}
        </Link>
      </p>
      <h1 className="h3 mb-1">{campaign.data?.name ?? t('campaigns.detail.title')}</h1>
      <p className="cb-text-secondary small">
        {campaign.data && (
          <>
            <CampaignStatusBadge status={campaign.data.status} />
            <span className="ms-2">
              {campaign.data.companyName} · {campaign.data.role.title}
            </span>
          </>
        )}
      </p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {invite && (
        <InviteLinkPanel
          invitePath={invite.invitePath}
          campaignName={invite.campaign.name}
          onDismiss={() => setInvite(null)}
        />
      )}
      {campaign.isPending && <LoadingRow />}
      {campaign.isError && <ErrorAlert error={campaignError(t, campaign.error)} />}
      {campaign.data && (
        <>
          <Settings campaign={campaign.data} />
          {canManage && editing && (
            <CampaignEditForm
              campaign={campaign.data}
              onDone={(saved) => {
                setEditing(false);
                if (saved) setNotice(t('campaigns.edit.saved'));
              }}
            />
          )}
          {canManage && !editing && (
            <Actions
              campaign={campaign.data}
              onNotice={(text) => {
                setInvite(null);
                setNotice(text);
              }}
              onInvite={(result) => {
                setNotice(null);
                setInvite(result);
              }}
              onEdit={() => {
                setNotice(null);
                setEditing(true);
              }}
            />
          )}
          <CampaignResultsSection campaign={campaign.data} />
        </>
      )}
    </>
  );
}
