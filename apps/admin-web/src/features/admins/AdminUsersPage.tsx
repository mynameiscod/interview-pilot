import { zodResolver } from '@hookform/resolvers/zod';
import { AdminRole, type AdminUserSummary, type InviteAdminResponse } from '@cbi/shared-types';
import { errorMessage } from '@cbi/web-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useAdminAuth, useCan } from '../../app/session';

const InviteForm = z.object({
  email: z.email(),
  roles: z.array(AdminRole).min(1),
});

function RoleCheckboxes({
  idPrefix,
  selected,
  onChange,
}: {
  idPrefix: string;
  selected: AdminRole[];
  onChange: (roles: AdminRole[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="d-flex flex-wrap gap-3">
      {AdminRole.options.map((role) => (
        <div className="form-check" key={role}>
          <input
            id={`${idPrefix}-${role}`}
            type="checkbox"
            className="form-check-input"
            checked={selected.includes(role)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, role] : selected.filter((r) => r !== role))
            }
          />
          <label htmlFor={`${idPrefix}-${role}`} className="form-check-label">
            {t(`roles.${role}`)}
          </label>
        </div>
      ))}
    </div>
  );
}

function InviteAdmin() {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<InviteAdminResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof InviteForm>>({
    resolver: zodResolver(InviteForm),
    defaultValues: { email: '', roles: [] },
  });
  const roles = watch('roles');

  return (
    <section
      className="p-4 border cb-border rounded-3 bg-white mb-4"
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="h5">
        {t('admins.inviteTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('admins.inviteHint')}</p>
      {result && (
        <div
          className={`alert ${result.inviteEmailSent ? 'alert-success' : 'alert-warning'}`}
          role="status"
        >
          {result.inviteEmailSent
            ? t('admins.invited', { email: result.admin.email })
            : t('admins.invitedNoEmail', { email: result.admin.email })}
        </div>
      )}
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <form
        noValidate
        onSubmit={handleSubmit(async (values) => {
          setError(null);
          setResult(null);
          try {
            setResult(await manager.api.post<InviteAdminResponse>('/admin/users', values));
            reset();
            await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
          } catch (err) {
            setError(errorMessage(t, err));
          }
        })}
      >
        <div className="mb-3">
          <label htmlFor={`${id}-email`} className="form-label">
            {t('admins.email')}
          </label>
          <input
            id={`${id}-email`}
            type="email"
            className={`form-control ${errors.email ? 'is-invalid' : ''}`}
            autoComplete="off"
            {...register('email')}
          />
          {errors.email && <div className="invalid-feedback">{t('errors.invalidEmail')}</div>}
        </div>
        <fieldset className="mb-3">
          <legend className="form-label fs-6">{t('admins.roles')}</legend>
          <RoleCheckboxes
            idPrefix={`${id}-role`}
            selected={roles}
            onChange={(next) => setValue('roles', next, { shouldValidate: true })}
          />
          {errors.roles && (
            <div className="small text-danger mt-1" role="alert">
              {t('admins.rolesRequired')}
            </div>
          )}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
          {t('admins.invite')}
        </button>
      </form>
    </section>
  );
}

function AdminRow({
  admin,
  isSelf,
  canManage,
}: {
  admin: AdminUserSummary;
  isSelf: boolean;
  canManage: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'view' | 'roles' | 'revoke'>('view');
  const [roles, setRoles] = useState<AdminRole[]>(admin.roles);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      mode === 'roles'
        ? manager.api.put(`/admin/users/${admin.id}/roles`, { roles, reason })
        : manager.api.post(`/admin/users/${admin.id}/revoke-access`, { reason }),
    onSuccess: async () => {
      setMode('view');
      setReason('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err) => setError(errorMessage(t, err)),
  });

  const lastLogin = admin.lastLoginAt
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(admin.lastLoginAt),
      )
    : t('admins.never');

  return (
    <>
      <tr>
        <td>
          <div className="fw-semibold">{admin.displayName ?? admin.email}</div>
          {admin.displayName && <div className="small cb-text-secondary">{admin.email}</div>}
          {!admin.emailVerified && (
            <span className="badge text-bg-light border cb-border mt-1">
              {t('admins.pendingFirstSignIn')}
            </span>
          )}
        </td>
        <td>
          <div className="d-flex flex-wrap gap-1">
            {admin.roles.map((role) => (
              <span key={role} className="badge text-bg-primary">
                {t(`roles.${role}`)}
              </span>
            ))}
          </div>
        </td>
        <td className="small">{lastLogin}</td>
        <td className="text-end text-nowrap">
          {canManage && !isSelf && mode === 'view' && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-outline-primary me-2"
                onClick={() => setMode('roles')}
              >
                {t('admins.editRoles')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={() => setMode('revoke')}
              >
                {t('admins.revoke')}
              </button>
            </>
          )}
          {isSelf && <span className="small cb-text-secondary">{t('admins.you')}</span>}
        </td>
      </tr>
      {mode !== 'view' && (
        <tr>
          <td colSpan={4} className="cb-surface-muted">
            <form
              className="p-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              {mode === 'roles' && (
                <fieldset className="mb-3">
                  <legend className="form-label fs-6">{t('admins.roles')}</legend>
                  <RoleCheckboxes idPrefix={`${id}-edit`} selected={roles} onChange={setRoles} />
                </fieldset>
              )}
              {mode === 'revoke' && (
                <p className="mb-2">{t('admins.revokeExplain', { email: admin.email })}</p>
              )}
              <label htmlFor={`${id}-reason`} className="form-label">
                {t('admins.reason')}
              </label>
              <input
                id={`${id}-reason`}
                className="form-control mb-2"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                required
              />
              {error && (
                <div className="alert alert-danger py-2" role="alert">
                  {error}
                </div>
              )}
              <div className="d-flex gap-2">
                <button
                  type="submit"
                  className={`btn btn-sm ${mode === 'revoke' ? 'btn-danger' : 'btn-primary'}`}
                  disabled={
                    save.isPending ||
                    reason.trim().length < 3 ||
                    (mode === 'roles' && roles.length === 0)
                  }
                >
                  {mode === 'revoke' ? t('admins.confirmRevoke') : t('admins.saveRoles')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => {
                    setMode('view');
                    setRoles(admin.roles);
                    setError(null);
                  }}
                >
                  {t('admins.cancel')}
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  const { manager, user } = useAdminAuth();
  const canManage = useCan('admin_users.manage');
  const admins = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => manager.api.get<AdminUserSummary[]>('/admin/users'),
  });

  return (
    <>
      <h1 className="h3 mb-4">{t('admins.title')}</h1>
      {canManage && <InviteAdmin />}
      <section className="border cb-border rounded-3 bg-white" aria-label={t('admins.listLabel')}>
        {admins.isPending && (
          <div className="p-4" role="status">
            {t('common.loading')}
          </div>
        )}
        {admins.isError && (
          <div className="alert alert-danger m-3" role="alert">
            {errorMessage(t, admins.error)}
          </div>
        )}
        {admins.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('admins.person')}</th>
                  <th scope="col">{t('admins.roles')}</th>
                  <th scope="col">{t('admins.lastSignIn')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('admins.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {admins.data.map((admin) => (
                  <AdminRow
                    key={admin.id}
                    admin={admin}
                    isSelf={admin.id === user?.id}
                    canManage={canManage}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
