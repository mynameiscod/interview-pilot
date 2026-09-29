import {
  OrgRole,
  UpdateScorecardCriteriaBody,
  type InviteOrgMemberResponse,
  type OrgMemberSummary,
  type OrgSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleError } from '../features/ai/format';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { formatDateTime } from '../features/library/format';
import { orgKeys, useOrganisation, useOrgMembers } from './queries';
import { useOrgAuth, useOrgCan } from './session';

function CriteriaEditor({ org }: { org: OrgSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState(org.scorecardCriteria.map((c) => c.label).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const labels = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const body = {
      criteria: labels.map((label) => ({
        label,
        key:
          label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'criterion',
      })),
    };
    const parsed = UpdateScorecardCriteriaBody.safeParse(body);
    if (!parsed.success) {
      setError(t('orgPortal.team.criteriaInvalid'));
      return;
    }
    try {
      await manager.api.put('/org/organisation/scorecard', parsed.data);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: orgKeys.organisation });
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <form className="p-3 border cb-border rounded-3 bg-white" onSubmit={(e) => void save(e)}>
      <h2 className="h6">{t('orgPortal.team.criteria')}</h2>
      <label htmlFor={`${id}-criteria`} className="form-label small">
        {t('orgPortal.team.criteriaLabel')}
      </label>
      <textarea
        id={`${id}-criteria`}
        rows={5}
        className="form-control form-control-sm mb-2"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ErrorAlert error={error} />
      <button type="submit" className="btn btn-sm btn-primary">
        {t('orgPortal.team.saveCriteria')}
      </button>
      <span role="status" className="small ms-2">
        {saved ? t('orgPortal.scorecard.saved') : ''}
      </span>
    </form>
  );
}

export function OrgTeamPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager, user } = useOrgAuth();
  const queryClient = useQueryClient();
  const canManage = useOrgCan('org.members.manage');
  const org = useOrganisation();
  const members = useOrgMembers();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('ORG_RECRUITER');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orgKeys.members }),
      queryClient.invalidateQueries({ queryKey: orgKeys.organisation }),
    ]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await manager.api.post<InviteOrgMemberResponse>('/org/members', {
        email: email.trim(),
        role,
      });
      setMessage(
        result.inviteEmailSent
          ? t('orgPortal.team.invited', { email: email.trim() })
          : t('orgPortal.team.invitedNoEmail', { email: email.trim() }),
      );
      setEmail('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  async function change(member: OrgMemberSummary, next: OrgRole | 'remove') {
    setError(null);
    try {
      if (next === 'remove') await manager.api.delete(`/org/members/${member.id}`);
      else await manager.api.put(`/org/members/${member.id}`, { role: next });
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  if (org.isPending || members.isPending) return <LoadingRow />;
  if (org.isError) return <ErrorAlert error={consoleError(t, org.error)} />;
  const o = org.data;

  return (
    <>
      <h1 className="h3">{t('orgPortal.team.title')}</h1>
      <div className="row g-3 mb-3">
        {(
          [
            ['seats', t('orgPortal.team.seatsValue', o.seats)],
            [
              'quota',
              o.interviewQuota.total === null
                ? t('orgPortal.team.quotaUnlimited', { used: o.interviewQuota.used })
                : t('orgPortal.team.quotaValue', o.interviewQuota),
            ],
            ['wallet', t('orgPortal.team.walletValue', o.wallet)],
          ] as const
        ).map(([key, value]) => (
          <div className="col-md-4" key={key}>
            <div className="p-3 border cb-border rounded-3 bg-white h-100">
              <div className="small cb-text-secondary">{t(`orgPortal.team.${key}`)}</div>
              <div className="fw-semibold">{value}</div>
            </div>
          </div>
        ))}
      </div>
      {canManage && (
        <form className="row g-2 align-items-end mb-3" onSubmit={(e) => void invite(e)}>
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
      <div role="status" aria-live="polite" className="small mb-2">
        {message}
      </div>
      <ErrorAlert error={error} />
      <div className="table-responsive border cb-border rounded-3 bg-white mb-3">
        <table className="table table-sm align-middle mb-0">
          <caption className="visually-hidden">{t('orgPortal.team.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('orgPortal.invites.email')}</th>
              <th scope="col">{t('orgPortal.team.role')}</th>
              <th scope="col">{t('orgPortal.team.status')}</th>
              <th scope="col">{t('orgPortal.team.lastLogin')}</th>
              {canManage && (
                <th scope="col">
                  <span className="visually-hidden">{t('orgPortal.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {(members.data ?? []).map((m) => (
              <tr key={m.id}>
                <td>
                  {m.email}
                  {m.name && <div className="small cb-text-secondary">{m.name}</div>}
                </td>
                <td>
                  {canManage && m.userId !== user?.id ? (
                    <select
                      className="form-select form-select-sm w-auto"
                      aria-label={t('orgPortal.team.roleFor', { email: m.email })}
                      value={m.role}
                      onChange={(e) => void change(m, e.target.value as OrgRole)}
                    >
                      {OrgRole.options.map((r) => (
                        <option key={r} value={r}>
                          {t(`orgPortal.roles.${r}`)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    t(`orgPortal.roles.${m.role}`)
                  )}
                </td>
                <td>{t(`orgPortal.memberStatus.${m.status}`)}</td>
                <td className="small">{formatDateTime(m.lastLoginAt, i18n.language)}</td>
                {canManage && (
                  <td className="text-end">
                    {m.userId !== user?.id && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        aria-label={t('orgPortal.team.removeOne', { email: m.email })}
                        onClick={() => void change(m, 'remove')}
                      >
                        {t('orgPortal.team.remove')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && <CriteriaEditor org={o} />}
    </>
  );
}
