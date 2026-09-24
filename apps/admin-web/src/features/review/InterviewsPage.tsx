import { InterviewState } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { campaignError } from '../campaigns/format';
import { useCampaigns } from '../campaigns/queries';
import { formatDateTime } from '../library/format';
import { useAdminInterviews } from './queries';
import { BandLabel, FlagBadge, InterviewStateBadge } from './shared';

const isState = (value: string | null): value is InterviewState =>
  InterviewState.safeParse(value).success;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function CampaignSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const campaigns = useCampaigns();
  return (
    <>
      <label htmlFor={id} className="form-label small">
        {t('review.list.campaignFilter')}
      </label>
      <select
        id={id}
        className="form-select form-select-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('review.list.anyCampaign')}</option>
        {(campaigns.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {/* A campaign from the URL that is not (yet) in the list stays selectable. */}
        {value && !campaigns.data?.some((c) => c.id === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </>
  );
}

export function InterviewsPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const canSeeCampaigns = useCan('campaigns.read');
  // Filters live in the URL so returning from an interview keeps them.
  const [params, setParams] = useSearchParams();
  const rawState = params.get('state');
  const state = isState(rawState) ? rawState : '';
  const rawCampaign = params.get('campaignId') ?? '';
  const campaignId = OBJECT_ID.test(rawCampaign) ? rawCampaign : '';
  const rawFlagged = params.get('flagged');
  const flagged = rawFlagged === 'true' || rawFlagged === 'false' ? rawFlagged : '';
  const q = params.get('q')?.trim() ?? '';
  const [stateInput, setStateInput] = useState<string>(state);
  const [campaignInput, setCampaignInput] = useState(campaignId);
  const [flaggedInput, setFlaggedInput] = useState<string>(flagged);
  const [qInput, setQInput] = useState(q);
  const interviews = useAdminInterviews({ state, campaignId, flagged, q });

  return (
    <>
      <h1 className="h3 mb-2">{t('review.list.title')}</h1>
      <p className="cb-text-secondary">{t('review.list.subtitle')}</p>
      <form
        role="search"
        aria-label={t('review.list.filtersLabel')}
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          if (stateInput) next.set('state', stateInput);
          if (campaignInput) next.set('campaignId', campaignInput);
          if (flaggedInput) next.set('flagged', flaggedInput);
          if (qInput.trim()) next.set('q', qInput.trim());
          setParams(next);
        }}
      >
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-state`} className="form-label small">
            {t('review.list.stateFilter')}
          </label>
          <select
            id={`${id}-state`}
            className="form-select form-select-sm"
            value={stateInput}
            onChange={(e) => setStateInput(e.target.value)}
          >
            <option value="">{t('review.list.allStates')}</option>
            {InterviewState.options.map((s) => (
              <option key={s} value={s}>
                {t(`review.states.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {canSeeCampaigns && (
          <div className="col-sm-6 col-lg-3">
            <CampaignSelect
              id={`${id}-campaign`}
              value={campaignInput}
              onChange={setCampaignInput}
            />
          </div>
        )}
        <div className="col-sm-6 col-lg-2">
          <label htmlFor={`${id}-flagged`} className="form-label small">
            {t('review.list.flagFilter')}
          </label>
          <select
            id={`${id}-flagged`}
            className="form-select form-select-sm"
            value={flaggedInput}
            onChange={(e) => setFlaggedInput(e.target.value)}
          >
            <option value="">{t('review.list.anyFlag')}</option>
            <option value="true">{t('review.list.onlyFlagged')}</option>
            <option value="false">{t('review.list.notFlagged')}</option>
          </select>
        </div>
        <div className="col-sm-6 col-lg-3">
          <label htmlFor={`${id}-q`} className="form-label small">
            {t('review.list.search')}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            className="form-control form-control-sm"
            maxLength={120}
            value={qInput}
            aria-describedby={`${id}-q-hint`}
            onChange={(e) => setQInput(e.target.value)}
          />
          <div id={`${id}-q-hint`} className="form-text">
            {t('review.list.searchHint')}
          </div>
        </div>
        <div className="col-lg-2 pb-lg-4">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('payments.purchases.apply')}
          </button>
        </div>
      </form>
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('review.list.listLabel')}
      >
        {interviews.isPending && <LoadingRow />}
        {interviews.isError && (
          <div className="m-3">
            <ErrorAlert error={campaignError(t, interviews.error)} />
          </div>
        )}
        {interviews.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('review.list.started')}</th>
                  <th scope="col">{t('review.list.interview')}</th>
                  <th scope="col">{t('review.list.candidate')}</th>
                  <th scope="col">{t('review.list.campaign')}</th>
                  <th scope="col">{t('review.list.state')}</th>
                  <th scope="col" className="text-end">
                    {t('campaigns.results.overall')}
                  </th>
                  <th scope="col">{t('campaigns.results.band')}</th>
                  <th scope="col">{t('review.list.flag')}</th>
                </tr>
              </thead>
              <tbody>
                {interviews.data.length === 0 && (
                  <tr>
                    <td colSpan={8} className="cb-text-secondary">
                      {t('review.list.empty')}
                    </td>
                  </tr>
                )}
                {interviews.data.map((row) => (
                  <tr key={row.id}>
                    <td className="small text-nowrap">
                      {row.startedAt ? formatDateTime(row.startedAt, i18n.language) : '—'}
                    </td>
                    <th scope="row" className="fw-normal">
                      <Link
                        to={`/interviews/${row.id}`}
                        aria-label={t('review.list.openLabel', { id: row.id })}
                      >
                        {row.title}
                      </Link>
                      <div className="small cb-text-secondary">
                        <span className="font-monospace">{row.id}</span> ·{' '}
                        {t(`library.modes.${row.mode}`)}
                      </div>
                    </th>
                    <td className="small">
                      {row.candidate.email ?? (
                        <span className="cb-text-secondary">{row.candidate.userId}</span>
                      )}
                    </td>
                    <td className="small">
                      {row.campaign === null ? (
                        '—'
                      ) : canSeeCampaigns ? (
                        <Link to={`/campaigns/${row.campaign.id}`}>{row.campaign.name}</Link>
                      ) : (
                        row.campaign.name
                      )}
                    </td>
                    <td>
                      <InterviewStateBadge state={row.state} />
                    </td>
                    <td className="text-end fw-semibold">{row.overall ?? '—'}</td>
                    <td className="small">
                      <BandLabel band={row.band} />
                    </td>
                    <td>
                      <FlagBadge flag={row.flag} />
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
