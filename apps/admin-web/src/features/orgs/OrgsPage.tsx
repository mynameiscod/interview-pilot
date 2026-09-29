import {
  CreateOrgBody,
  OrgRole,
  OrgType,
  type InviteOrgMemberResponse,
  type OrgListPage,
  type OrgMemberSummary,
  type OrgSummary,
} from '@cbi/shared-types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { Pager } from '../campaigns/shared';
import { formatDateTime } from '../library/format';

const orgsKeys = {
  all: ['admin-orgs'] as const,
  list: (page: number) => ['admin-orgs', 'list', page] as const,
  org: (id: string) => ['admin-orgs', 'org', id] as const,
  members: (id: string) => ['admin-orgs', 'members', id] as const,
};

function CreateOrgForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    type: 'EMPLOYER' as OrgType,
    seats: '5',
    interviewQuota: '',
    walletCredits: '0',
    mfaRequired: false,
    ownerEmail: '',
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = CreateOrgBody.safeParse({
      ...form,
      name: form.name.trim(),
      ownerEmail: form.ownerEmail.trim(),
      seats: Number(form.seats),
      interviewQuota: form.interviewQuota ? Number(form.interviewQuota) : null,
      walletCredits: Number(form.walletCredits),
    });
    if (!parsed.success) {
      setError(t('orgs.create.invalid'));
      return;
    }
    try {
      await manager.api.post('/admin/orgs', parsed.data);
      await queryClient.invalidateQueries({ queryKey: orgsKeys.all });
      onDone();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  const input = (
    key: 'name' | 'seats' | 'interviewQuota' | 'walletCredits' | 'ownerEmail',
    type = 'text',
  ) => (
    <div className="col-md-4" key={key}>
      <label htmlFor={`${id}-${key}`} className="form-label small">
        {t(`orgs.fields.${key}`)}
      </label>
      <input
        id={`${id}-${key}`}
        type={type}
        className="form-control form-control-sm"
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <form className="p-3 border cb-border rounded-3 bg-white mb-3" onSubmit={(e) => void submit(e)}>
      <h2 className="h6">{t('orgs.create.title')}</h2>
      <div className="row g-2 mb-2">
        {input('name')}
        <div className="col-md-4">
          <label htmlFor={`${id}-type`} className="form-label small">
            {t('orgs.fields.type')}
          </label>
          <select
            id={`${id}-type`}
            className="form-select form-select-sm"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as OrgType }))}
          >
            {OrgType.options.map((type) => (
              <option key={type} value={type}>
                {t(`orgPortal.orgTypes.${type}`)}
              </option>
            ))}
          </select>
        </div>
        {input('ownerEmail', 'email')}
        {input('seats', 'number')}
        {input('interviewQuota', 'number')}
        {input('walletCredits', 'number')}
        <div className="col-12 form-check form-switch ms-2">
          <input
            id={`${id}-mfa`}
            type="checkbox"
            role="switch"
            className="form-check-input"
            checked={form.mfaRequired}
            onChange={(e) => setForm((f) => ({ ...f, mfaRequired: e.target.checked }))}
          />
          <label htmlFor={`${id}-mfa`} className="form-check-label">
            {t('orgs.fields.mfaRequired')}
          </label>
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary">
          {t('orgs.create.submit')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onDone}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Organisations (employers and colleges) using the self-serve portal. */
export function OrgsPage() {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('orgs.manage');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const orgs = useQuery({
    queryKey: orgsKeys.list(page),
    queryFn: () => manager.api.get<OrgListPage>(`/admin/orgs?page=${page}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <h1 className="h3 mb-0">{t('orgs.title')}</h1>
        {canManage && !creating && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setCreating(true)}
          >
            <i className="bi bi-plus-lg me-1" aria-hidden="true" />
            {t('orgs.new')}
          </button>
        )}
      </div>
      <p className="cb-text-secondary">{t('orgs.intro')}</p>
      {creating && <CreateOrgForm onDone={() => setCreating(false)} />}
      {orgs.isPending ? (
        <LoadingRow />
      ) : orgs.isError ? (
        <ErrorAlert error={consoleError(t, orgs.error)} />
      ) : orgs.data.items.length === 0 ? (
        <p className="p-4 border cb-border rounded-3 bg-white">{t('orgs.empty')}</p>
      ) : (
        <div className="table-responsive border cb-border rounded-3 bg-white">
          <table className="table table-sm align-middle mb-0">
            <caption className="visually-hidden">{t('orgs.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('orgs.fields.name')}</th>
                <th scope="col">{t('orgs.fields.type')}</th>
                <th scope="col">{t('orgs.fields.status')}</th>
                <th scope="col">{t('orgs.fields.seats')}</th>
                <th scope="col">{t('orgs.fields.walletCredits')}</th>
                <th scope="col">{t('orgs.fields.created')}</th>
              </tr>
            </thead>
            <tbody>
              {orgs.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/orgs/${o.id}`}>{o.name}</Link>
                  </td>
                  <td>{t(`orgPortal.orgTypes.${o.type}`)}</td>
                  <td>{t(`orgs.status.${o.status}`)}</td>
                  <td>
                    {o.seats.used}/{o.seats.total}
                  </td>
                  <td>{o.wallet.balance}</td>
                  <td className="small">{formatDateTime(o.createdAt, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {orgs.data && (
        <Pager page={page} pageSize={orgs.data.pageSize} total={orgs.data.total} onPage={setPage} />
      )}
    </>
  );
}

/** One organisation: limits, wallet, status and members. */
export function OrgDetailPage() {
  const { t, i18n } = useTranslation();
  const { orgId = '' } = useParams();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canManage = useCan('orgs.manage');
  const org = useQuery({
    queryKey: orgsKeys.org(orgId),
    queryFn: () => manager.api.get<OrgSummary>(`/admin/orgs/${encodeURIComponent(orgId)}`),
  });
  const members = useQuery({
    queryKey: orgsKeys.members(orgId),
    queryFn: () =>
      manager.api.get<OrgMemberSummary[]>(`/admin/orgs/${encodeURIComponent(orgId)}/members`),
  });
  const [action, setAction] = useState<'wallet' | 'status' | null>(null);
  const [delta, setDelta] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('ORG_OWNER');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orgsKeys.all });

  if (org.isPending) return <LoadingRow />;
  if (org.isError) return <ErrorAlert error={consoleError(t, org.error)} />;
  const o = org.data;

  async function run(reason: string) {
    setPending(true);
    setError(null);
    try {
      if (action === 'wallet') {
        await manager.api.post(`/admin/orgs/${o.id}/wallet`, { delta: Number(delta), reason });
      } else {
        await manager.api.post(`/admin/orgs/${o.id}/status`, {
          status: o.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
          reason,
        });
      }
      setAction(null);
      setDelta('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    } finally {
      setPending(false);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await manager.api.post<InviteOrgMemberResponse>(`/admin/orgs/${o.id}/members`, {
        email: email.trim(),
        role,
      });
      setEmail('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <>
      <nav aria-label={t('orgPortal.breadcrumb')} className="small mb-2">
        <Link to="/orgs">{t('orgs.title')}</Link>
      </nav>
      <h1 className="h3">
        {o.name}{' '}
        <span className="badge text-bg-light border cb-border fs-6">
          {t(`orgPortal.orgTypes.${o.type}`)}
        </span>{' '}
        <span
          className={`badge fs-6 ${o.status === 'ACTIVE' ? 'text-bg-success' : 'text-bg-danger'}`}
        >
          {t(`orgs.status.${o.status}`)}
        </span>
      </h1>
      <dl className="row small mb-3">
        <dt className="col-sm-3">{t('orgs.fields.seats')}</dt>
        <dd className="col-sm-9">{t('orgPortal.team.seatsValue', o.seats)}</dd>
        <dt className="col-sm-3">{t('orgs.fields.interviewQuota')}</dt>
        <dd className="col-sm-9">
          {o.interviewQuota.total === null
            ? t('orgPortal.team.quotaUnlimited', { used: o.interviewQuota.used })
            : t('orgPortal.team.quotaValue', o.interviewQuota)}
        </dd>
        <dt className="col-sm-3">{t('orgs.fields.walletCredits')}</dt>
        <dd className="col-sm-9">{t('orgPortal.team.walletValue', o.wallet)}</dd>
        <dt className="col-sm-3">{t('orgs.fields.mfaRequired')}</dt>
        <dd className="col-sm-9">{o.mfaRequired ? t('orgPortal.yes') : t('orgPortal.no')}</dd>
      </dl>
      {canManage && (
        <div className="d-flex flex-wrap gap-2 mb-3">
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            onClick={() => setAction('wallet')}
          >
            {t('orgs.wallet.adjust')}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${o.status === 'ACTIVE' ? 'btn-outline-danger' : 'btn-outline-success'}`}
            onClick={() => setAction('status')}
          >
            {o.status === 'ACTIVE' ? t('orgs.suspend') : t('orgs.reactivate')}
          </button>
        </div>
      )}
      {action && (
        <ReasonForm
          submitLabel={
            action === 'wallet'
              ? t('orgs.wallet.adjust')
              : o.status === 'ACTIVE'
                ? t('orgs.suspend')
                : t('orgs.reactivate')
          }
          danger={action === 'status' && o.status === 'ACTIVE'}
          pending={pending}
          error={error}
          disabled={action === 'wallet' && !/^-?\d+$/.test(delta.trim())}
          onSubmit={(reason) => void run(reason)}
          onCancel={() => setAction(null)}
        >
          {action === 'wallet' && (
            <div className="mb-2">
              <label htmlFor={`${id}-delta`} className="form-label">
                {t('orgs.wallet.delta')}
              </label>
              <input
                id={`${id}-delta`}
                type="number"
                className="form-control form-control-sm"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
              />
            </div>
          )}
        </ReasonForm>
      )}
      <h2 className="h5 mt-3">{t('orgs.members')}</h2>
      {canManage && (
        <form className="row g-2 align-items-end mb-2" onSubmit={(e) => void invite(e)}>
          <div className="col-sm-6 col-lg-4">
            <label htmlFor={`${id}-email`} className="form-label small">
              {t('orgPortal.invites.email')}
            </label>
            <input
              id={`${id}-email`}
              type="email"
              required
              className="form-control form-control-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="col-sm-4 col-lg-3">
            <label htmlFor={`${id}-role`} className="form-label small">
              {t('orgPortal.team.role')}
            </label>
            <select
              id={`${id}-role`}
              className="form-select form-select-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
            >
              {OrgRole.options.map((r) => (
                <option key={r} value={r}>
                  {t(`orgPortal.roles.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-auto">
            <button type="submit" className="btn btn-sm btn-primary">
              {t('orgPortal.team.invite')}
            </button>
          </div>
        </form>
      )}
      {!action && <ErrorAlert error={error} />}
      {members.isPending ? (
        <LoadingRow />
      ) : (
        <ul className="list-group">
          {(members.data ?? []).map((m) => (
            <li key={m.id} className="list-group-item d-flex justify-content-between">
              <span>
                {m.email} · {t(`orgPortal.roles.${m.role}`)}
              </span>
              <span className="small cb-text-secondary">
                {t(`orgPortal.memberStatus.${m.status}`)} ·{' '}
                {formatDateTime(m.lastLoginAt, i18n.language)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
