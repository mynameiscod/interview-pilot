import type { CandidateDetail, CandidatePage, UserStatus } from '@cbi/shared-types';
import { errorMessage } from '@cbi/web-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatMoney } from '../payments/format';

const candidateKeys = {
  search: (q: string, status: string) => ['candidates', 'search', q, status] as const,
  detail: (id: string) => ['candidates', 'detail', id] as const,
};

const STATUS_BADGE: Record<UserStatus, string> = {
  ACTIVE: 'text-bg-success',
  SUSPENDED: 'text-bg-danger',
  DELETION_PENDING: 'text-bg-warning',
  DELETED: 'text-bg-secondary',
};

function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${STATUS_BADGE[status]}`}>{t(`candidates.status.${status}`)}</span>
  );
}

/** `/candidates`: support search by email, mobile number or name. */
export function CandidatesPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const status = params.get('status') ?? '';
  const [input, setInput] = useState(q);
  const [statusInput, setStatusInput] = useState(status);
  const results = useQuery({
    queryKey: candidateKeys.search(q, status),
    queryFn: () => {
      const search = new URLSearchParams({ limit: '50' });
      if (q) search.set('q', q);
      if (status) search.set('status', status);
      return manager.api.get<CandidatePage>(`/admin/candidates?${search.toString()}`);
    },
  });

  return (
    <>
      <h1 className="h3 mb-2">{t('candidates.title')}</h1>
      <p className="cb-text-secondary">{t('candidates.subtitle')}</p>
      <form
        role="search"
        aria-label={t('candidates.searchForm')}
        className="d-flex flex-wrap align-items-end gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          if (input.trim()) next.set('q', input.trim());
          if (statusInput) next.set('status', statusInput);
          setParams(next);
        }}
      >
        <div className="flex-grow-1" style={{ minWidth: '16rem' }}>
          <label htmlFor={`${id}-q`} className="form-label small">
            {t('candidates.searchLabel')}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            className="form-control"
            placeholder={t('candidates.searchPlaceholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${id}-status`} className="form-label small">
            {t('candidates.statusFilter')}
          </label>
          <select
            id={`${id}-status`}
            className="form-select"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value)}
          >
            <option value="">{t('candidates.anyStatus')}</option>
            {(['ACTIVE', 'SUSPENDED', 'DELETION_PENDING'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`candidates.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          {t('candidates.search')}
        </button>
      </form>
      <p className="small cb-text-secondary">{t('candidates.auditNote')}</p>

      {results.isPending && <LoadingRow />}
      <ErrorAlert error={results.isError ? errorMessage(t, results.error) : null} />
      {results.data && results.data.items.length === 0 && (
        <p className="cb-text-secondary">{t('candidates.none')}</p>
      )}
      {results.data && results.data.items.length > 0 && (
        <div className="table-responsive bg-white border cb-border rounded-3">
          <table className="table mb-0 align-middle">
            <thead>
              <tr>
                <th scope="col">{t('candidates.name')}</th>
                <th scope="col">{t('candidates.contact')}</th>
                <th scope="col">{t('candidates.statusFilter')}</th>
                <th scope="col">{t('candidates.lastSignIn')}</th>
              </tr>
            </thead>
            <tbody>
              {results.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/candidates/${c.id}`}>
                      {c.displayName ?? t('candidates.noName')}
                    </Link>
                  </td>
                  <td className="small text-break">
                    {[c.email, c.mobile].filter(Boolean).join(' · ')}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="small">
                    {c.lastLoginAt ? formatDateTime(c.lastLoginAt, i18n.language) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Suspend / reinstate with an audited reason. */
function StatusActions({ detail }: { detail: CandidateDetail }) {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canManage = useCan('candidates.manage');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { candidate } = detail;
  const suspended = candidate.status === 'SUSPENDED';
  if (!canManage || (candidate.status !== 'ACTIVE' && !suspended)) return null;

  async function submit(reason: string) {
    setPending(true);
    setError(null);
    try {
      await manager.api.post(
        `/admin/candidates/${encodeURIComponent(candidate.id)}/${suspended ? 'reinstate' : 'suspend'}`,
        { reason },
      );
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['candidates'] });
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  return open ? (
    <div className="mt-3" style={{ maxWidth: '32rem' }}>
      {!suspended && <p className="small">{t('candidates.suspendHint')}</p>}
      <ReasonForm
        submitLabel={suspended ? t('candidates.reinstate') : t('candidates.suspend')}
        danger={!suspended}
        pending={pending}
        error={error}
        onSubmit={(reason) => void submit(reason)}
        onCancel={() => setOpen(false)}
      />
    </div>
  ) : (
    <button
      type="button"
      className={`btn mt-3 ${suspended ? 'btn-outline-primary' : 'btn-outline-danger'}`}
      onClick={() => setOpen(true)}
    >
      {suspended ? t('candidates.reinstate') : t('candidates.suspend')}
    </button>
  );
}

/** `/candidates/:id`: profile, credits, interviews, purchases and consents. */
export function CandidateDetailPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const { manager } = useAdminAuth();
  const detail = useQuery({
    queryKey: candidateKeys.detail(id),
    queryFn: () => manager.api.get<CandidateDetail>(`/admin/candidates/${encodeURIComponent(id)}`),
    // Every view is audited server-side; do not refetch in the background.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const date = (iso: string) => formatDateTime(iso, i18n.language);

  if (detail.isPending) return <LoadingRow />;
  if (detail.isError) return <ErrorAlert error={errorMessage(t, detail.error)} />;
  const { candidate, credits, interviews, purchases, consents } = detail.data;

  return (
    <>
      <p className="small mb-2">
        <Link to="/candidates">{t('candidates.back')}</Link>
      </p>
      <h1 className="h3 d-flex flex-wrap align-items-center gap-2">
        {candidate.displayName ?? t('candidates.noName')}
        <StatusBadge status={candidate.status} />
      </h1>
      {candidate.suspension && (
        <div className="alert alert-danger" role="status">
          {t('candidates.suspendedOn', {
            date: date(candidate.suspension.at),
            reason: candidate.suspension.reason,
          })}
        </div>
      )}
      {candidate.deletionScheduledFor && (
        <div className="alert alert-warning" role="status">
          {t('candidates.deletionScheduled', { date: date(candidate.deletionScheduledFor) })}
        </div>
      )}
      <div className="row g-3">
        <section className="col-lg-6" aria-labelledby="profile-title">
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h2 id="profile-title" className="h5">
              {t('candidates.profile')}
            </h2>
            <dl className="row small mb-0">
              <dt className="col-5">{t('candidates.email')}</dt>
              <dd className="col-7 text-break">{candidate.email ?? '—'}</dd>
              <dt className="col-5">{t('candidates.mobile')}</dt>
              <dd className="col-7">{candidate.mobile ?? '—'}</dd>
              <dt className="col-5">{t('candidates.signInMethods')}</dt>
              <dd className="col-7">
                {candidate.identities.map((i) => `${i.provider} ${i.display}`).join(', ') || '—'}
              </dd>
              <dt className="col-5">{t('candidates.experience')}</dt>
              <dd className="col-7">{candidate.experienceLevel ?? '—'}</dd>
              <dt className="col-5">{t('candidates.currentRole')}</dt>
              <dd className="col-7">{candidate.currentRole ?? '—'}</dd>
              <dt className="col-5">{t('candidates.joined')}</dt>
              <dd className="col-7">{date(candidate.createdAt)}</dd>
              <dt className="col-5">{t('candidates.lastSignIn')}</dt>
              <dd className="col-7">{candidate.lastLoginAt ? date(candidate.lastLoginAt) : '—'}</dd>
              <dt className="col-5">{t('candidates.credits')}</dt>
              <dd className="col-7">
                {t('candidates.creditsValue', {
                  available: credits.available,
                  reserved: credits.reserved,
                })}
              </dd>
            </dl>
            <StatusActions detail={detail.data} />
          </div>
        </section>
        <section className="col-lg-6" aria-labelledby="consents-title">
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h2 id="consents-title" className="h5">
              {t('candidates.consents')}
            </h2>
            {consents.length === 0 ? (
              <p className="small mb-0">{t('candidates.noneYet')}</p>
            ) : (
              <ul className="list-unstyled small mb-0">
                {consents.map((c) => (
                  <li key={`${c.type}-${c.at}`}>
                    {c.type} v{c.version ?? '?'} ·{' '}
                    {c.accepted ? t('candidates.accepted') : t('candidates.declined')} ·{' '}
                    {date(c.at)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="col-lg-6" aria-labelledby="interviews-title">
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h2 id="interviews-title" className="h5">
              {t('candidates.interviews')}
            </h2>
            {interviews.length === 0 ? (
              <p className="small mb-0">{t('candidates.noneYet')}</p>
            ) : (
              <ul className="list-unstyled small mb-0">
                {interviews.map((i) => (
                  <li key={i.id}>
                    <Link to={`/interviews/${i.id}`}>{i.roleTitle ?? i.id}</Link> · {i.state}
                    {i.mode ? ` · ${i.mode}` : ''}
                    {i.campaign ? ` · ${i.campaign}` : ''} · {date(i.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="col-lg-6" aria-labelledby="purchases-title">
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h2 id="purchases-title" className="h5">
              {t('candidates.purchases')}
            </h2>
            {purchases.length === 0 ? (
              <p className="small mb-0">{t('candidates.noneYet')}</p>
            ) : (
              <ul className="list-unstyled small mb-0">
                {purchases.map((p) => (
                  <li key={p.id}>
                    <Link to={`/purchases/${p.id}`}>{p.planName ?? p.id}</Link> · {p.status}
                    {p.amountPaise !== null ? ` · ${formatMoney(p.amountPaise, 'INR')}` : ''} ·{' '}
                    {date(p.createdAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
