import {
  InviteLanguage,
  InviteStatus,
  type CampaignInviteSummary,
  type CampaignSummary,
  type CreateInvitesResult,
  type InvitePreview,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { consoleError } from '../features/ai/format';
import { Pager } from '../features/campaigns/shared';
import { formatDateTime } from '../features/library/format';
import { orgKeys, useOrgInvites } from './queries';
import { useOrgAuth, useOrgCan } from './session';
import { InviteStatusBadge } from './shared';

/** Most CSV text read in the browser (the API allows about 1 MB per preview). */
const MAX_CSV_BYTES = 900_000;

function SingleInviteForm({ campaign, college }: { campaign: CampaignSummary; college: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<InviteLanguage>('en');
  const [batch, setBatch] = useState('');
  const [branch, setBranch] = useState('');
  const [year, setYear] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await manager.api.post<CreateInvitesResult>(
        `/org/campaigns/${campaign.id}/invites`,
        {
          invites: [
            {
              email: email.trim(),
              name: name.trim() || null,
              language,
              tags: {
                batch: batch.trim() || null,
                branch: branch.trim() || null,
                year: year ? Number(year) : null,
              },
            },
          ],
        },
      );
      setMessage(
        result.created
          ? t('orgPortal.invites.sentOne', { email: email.trim() })
          : t('orgPortal.invites.already', { email: email.trim() }),
      );
      setEmail('');
      setName('');
      await queryClient.invalidateQueries({ queryKey: orgKeys.invites(campaign.id) });
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  const field = (key: string) => `${id}-${key}`;
  return (
    <form className="row g-2 align-items-end mb-2" onSubmit={(e) => void submit(e)}>
      <div className="col-sm-6 col-lg-3">
        <label htmlFor={field('email')} className="form-label small">
          {t('orgPortal.invites.email')}
        </label>
        <input
          id={field('email')}
          type="email"
          required
          className="form-control form-control-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="col-sm-6 col-lg-2">
        <label htmlFor={field('name')} className="form-label small">
          {t('orgPortal.invites.name')}
        </label>
        <input
          id={field('name')}
          className="form-control form-control-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="col-sm-4 col-lg-2">
        <label htmlFor={field('language')} className="form-label small">
          {t('orgPortal.invites.language')}
        </label>
        <select
          id={field('language')}
          className="form-select form-select-sm"
          value={language}
          onChange={(e) => setLanguage(e.target.value as InviteLanguage)}
        >
          {InviteLanguage.options.map((l) => (
            <option key={l} value={l}>
              {t(`campaigns.languages.${l}`)}
            </option>
          ))}
        </select>
      </div>
      {college &&
        (
          [
            ['batch', batch, setBatch],
            ['branch', branch, setBranch],
            ['year', year, setYear],
          ] as const
        ).map(([key, value, setter]) => (
          <div className="col-sm-4 col-lg-1" key={key}>
            <label htmlFor={field(key)} className="form-label small">
              {t(`orgPortal.invites.${key}`)}
            </label>
            <input
              id={field(key)}
              type={key === 'year' ? 'number' : 'text'}
              className="form-control form-control-sm"
              value={value}
              onChange={(e) => setter(e.target.value)}
            />
          </div>
        ))}
      <div className="col-auto">
        <button type="submit" className="btn btn-sm btn-primary">
          {t('orgPortal.invites.send')}
        </button>
      </div>
      <div className="col-12" role="status" aria-live="polite">
        <span className="small">{message}</span>
      </div>
      <div className="col-12">
        <ErrorAlert error={error} />
      </div>
    </form>
  );
}

/** Bulk upload: the file is checked by the server first; only valid rows are then invited. */
function CsvUpload({ campaign }: { campaign: CampaignSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(file: File) {
    setError(null);
    setMessage(null);
    setPreview(null);
    if (file.size > MAX_CSV_BYTES) {
      setError(t('orgPortal.invites.fileTooLarge'));
      return;
    }
    setBusy(true);
    try {
      setPreview(
        await manager.api.post<InvitePreview>(`/org/campaigns/${campaign.id}/invites/preview`, {
          csv: await file.text(),
        }),
      );
    } catch (err) {
      setError(consoleError(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await manager.api.post<CreateInvitesResult>(
        `/org/campaigns/${campaign.id}/invites`,
        { invites: preview.valid },
      );
      setMessage(t('orgPortal.invites.sentMany', { count: result.created }));
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: orgKeys.invites(campaign.id) });
    } catch (err) {
      setError(consoleError(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-3 cb-surface-muted rounded-2 mb-3">
      <label htmlFor={`${id}-file`} className="form-label small fw-semibold">
        {t('orgPortal.invites.csvLabel')}
      </label>
      <input
        id={`${id}-file`}
        type="file"
        accept=".csv,text/csv"
        className="form-control form-control-sm"
        aria-describedby={`${id}-hint`}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void check(file);
          e.target.value = '';
        }}
      />
      <div id={`${id}-hint`} className="form-text">
        {t('orgPortal.invites.csvHint')}
      </div>
      <ErrorAlert error={error} />
      <div role="status" aria-live="polite" className="small">
        {message}
      </div>
      {preview && (
        <div className="mt-2">
          <p className="mb-1">
            {t('orgPortal.invites.previewSummary', {
              valid: preview.valid.length,
              errors: preview.errors.length,
              duplicates: preview.duplicates.length,
            })}
          </p>
          {preview.errors.length > 0 && (
            <ul className="small text-danger mb-2">
              {preview.errors.slice(0, 20).map((e) => (
                <li key={e.line}>
                  {t('orgPortal.invites.lineError', { line: e.line, message: e.message })}
                </li>
              ))}
            </ul>
          )}
          {preview.duplicates.length > 0 && (
            <p className="small cb-text-secondary">
              {t('orgPortal.invites.duplicates', {
                emails: preview.duplicates.slice(0, 10).join(', '),
              })}
            </p>
          )}
          <div className="d-flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || preview.valid.length === 0}
              onClick={() => void confirm()}
            >
              {t('orgPortal.invites.confirm', { count: preview.valid.length })}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setPreview(null)}
            >
              {t('ai.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function OrgInvitesSection({
  campaign,
  college,
}: {
  campaign: CampaignSummary;
  college: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const canManage = useOrgCan('org.campaigns.manage');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const invites = useOrgInvites(campaign.id, status, page);

  async function act(invite: CampaignInviteSummary, action: 'revoke' | 'retry') {
    setError(null);
    try {
      await manager.api.post(`/org/campaigns/${campaign.id}/invites/${invite.id}/${action}`);
      await queryClient.invalidateQueries({ queryKey: orgKeys.invites(campaign.id) });
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="h5">
        {t('orgPortal.invites.title')}
      </h2>
      <p className="small cb-text-secondary">
        {campaign.requireInvite ? t('orgPortal.invites.inviteOnly') : t('orgPortal.invites.intro')}{' '}
        {campaign.reminders.enabled
          ? t('orgPortal.invites.reminders', {
              count: campaign.reminders.max,
              hours: campaign.reminders.intervalHours,
            })
          : t('orgPortal.invites.noReminders')}
      </p>
      {canManage && campaign.status !== 'CLOSED' && (
        <>
          <SingleInviteForm campaign={campaign} college={college} />
          <CsvUpload campaign={campaign} />
        </>
      )}
      {invites.data && (
        <ul className="list-inline small mb-2" aria-label={t('orgPortal.invites.funnel')}>
          {InviteStatus.options.map((s) => (
            <li key={s} className="list-inline-item">
              <InviteStatusBadge status={s} /> {invites.data.counts[s]}
            </li>
          ))}
        </ul>
      )}
      <div className="mb-2" style={{ maxWidth: '16rem' }}>
        <label htmlFor={`${id}-status`} className="form-label small">
          {t('orgPortal.invites.filter')}
        </label>
        <select
          id={`${id}-status`}
          className="form-select form-select-sm"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('orgPortal.pipeline.any')}</option>
          {InviteStatus.options.map((s) => (
            <option key={s} value={s}>
              {t(`orgPortal.inviteStatus.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <ErrorAlert error={error} />
      {invites.isPending ? (
        <LoadingRow />
      ) : invites.isError ? (
        <ErrorAlert error={consoleError(t, invites.error)} />
      ) : invites.data.items.length === 0 ? (
        <p className="p-3 border cb-border rounded-3 bg-white">{t('orgPortal.invites.empty')}</p>
      ) : (
        <div className="table-responsive border cb-border rounded-3 bg-white">
          <table className="table table-sm align-middle mb-0">
            <caption className="visually-hidden">{t('orgPortal.invites.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('orgPortal.invites.email')}</th>
                <th scope="col">{t('orgPortal.invites.statusCol')}</th>
                <th scope="col">{t('orgPortal.invites.sentAt')}</th>
                <th scope="col">{t('orgPortal.invites.remindersCol')}</th>
                {college && <th scope="col">{t('orgPortal.invites.tags')}</th>}
                {canManage && (
                  <th scope="col">
                    <span className="visually-hidden">{t('orgPortal.actions')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {invites.data.items.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    {invite.email}
                    {invite.name && <div className="small cb-text-secondary">{invite.name}</div>}
                  </td>
                  <td>
                    <InviteStatusBadge status={invite.status} />
                    {invite.lastError && (
                      <div className="small text-danger">{invite.lastError}</div>
                    )}
                  </td>
                  <td className="small">{formatDateTime(invite.sentAt, i18n.language)}</td>
                  <td>{invite.remindersSent}</td>
                  {college && (
                    <td className="small">
                      {[invite.tags.batch, invite.tags.branch, invite.tags.year]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                  )}
                  {canManage && (
                    <td className="text-end">
                      {invite.status === 'FAILED' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary me-1"
                          onClick={() => void act(invite, 'retry')}
                        >
                          {t('orgPortal.invites.retry')}
                        </button>
                      )}
                      {['PENDING', 'SENT', 'OPENED', 'FAILED'].includes(invite.status) && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          aria-label={t('orgPortal.invites.revokeOne', { email: invite.email })}
                          onClick={() => void act(invite, 'revoke')}
                        >
                          {t('orgPortal.invites.revoke')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invites.data && (
        <Pager
          page={page}
          pageSize={invites.data.pageSize}
          total={invites.data.total}
          onPage={setPage}
        />
      )}
    </section>
  );
}
