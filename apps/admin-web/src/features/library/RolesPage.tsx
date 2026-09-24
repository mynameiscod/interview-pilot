import { zodResolver } from '@hookform/resolvers/zod';
import {
  RoleFamily,
  Seniority,
  type BlueprintSummary,
  type RoleSummary,
  type UpsertRoleBody,
} from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import {
  fieldError,
  libraryError,
  slugify,
  splitList,
  validationIssues,
  type Issue,
} from './format';
import { useRoles } from './queries';
import { ActiveBadge, IssueList, RolesTabs } from './shared';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const RoleForm = z.object({
  title: z
    .string()
    .trim()
    .min(2, 'library.roles.errors.title')
    .max(120, 'library.roles.errors.title'),
  slug: z
    .string()
    .trim()
    .min(2, 'library.errors.slug')
    .max(60, 'library.errors.slug')
    .regex(SLUG, 'library.errors.slug'),
  family: RoleFamily,
  defaultSeniority: Seniority,
  aliases: z
    .string()
    .refine(
      (v) => splitList(v).every((a) => a.length >= 2 && a.length <= 120),
      'library.roles.errors.aliases',
    )
    .refine((v) => splitList(v).length <= 20, 'library.roles.errors.aliasCount'),
  active: z.boolean(),
});
type RoleFormValues = z.infer<typeof RoleForm>;

const FIELDS = ['title', 'slug', 'family', 'defaultSeniority', 'aliases', 'active'] as const;

function RoleEditor({
  role,
  onDone,
}: {
  role: RoleSummary | null;
  onDone: (saved: RoleSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [slugTouched, setSlugTouched] = useState(role !== null);
  const {
    register,
    handleSubmit,
    setValue,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<RoleFormValues>({
    resolver: zodResolver(RoleForm),
    defaultValues: role
      ? {
          title: role.title,
          slug: role.slug,
          family: role.family,
          defaultSeniority: role.defaultSeniority,
          aliases: role.aliases.join(', '),
          active: role.active,
        }
      : {
          title: '',
          slug: '',
          family: 'ENGINEERING',
          defaultSeniority: 'MID',
          aliases: '',
          active: true,
        },
  });

  const titleField = register('title');
  const slugField = register('slug');
  const describedBy = (field: keyof RoleFormValues, hint?: string) =>
    [errors[field] ? `${id}-${field}-error` : null, hint].filter(Boolean).join(' ') || undefined;

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-title-heading`}
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        setIssues([]);
        const body: UpsertRoleBody = {
          title: values.title.trim(),
          slug: values.slug.trim(),
          family: values.family,
          defaultSeniority: values.defaultSeniority,
          aliases: splitList(values.aliases),
          active: values.active,
        };
        try {
          const saved = role
            ? await manager.api.put<RoleSummary>(`/admin/roles/${role.id}`, body)
            : await manager.api.post<RoleSummary>('/admin/roles', body);
          await queryClient.invalidateQueries({ queryKey: ['library', 'roles'] });
          onDone(saved);
        } catch (err) {
          if (err instanceof ApiClientError && err.code === 'CONFLICT') {
            setFieldError('slug', { message: 'library.roles.errors.slugTaken' });
            return;
          }
          const found = validationIssues(err);
          const unmatched = found.filter((issue) => {
            const field = FIELDS.find((f) => issue.path === f || issue.path.startsWith(`${f}.`));
            if (field) setFieldError(field, { message: issue.message });
            return !field;
          });
          setIssues(unmatched);
          setError(found.length > 0 && unmatched.length === 0 ? null : libraryError(t, err));
        }
      })}
    >
      <h2 id={`${id}-title-heading`} className="h6">
        {role ? t('library.roles.editTitle', { title: role.title }) : t('library.roles.newTitle')}
      </h2>
      <div className="row g-2 mb-2">
        <div className="col-md-6">
          <label htmlFor={`${id}-title`} className="form-label small">
            {t('library.roles.titleField')}
          </label>
          <input
            id={`${id}-title`}
            className={`form-control form-control-sm ${errors.title ? 'is-invalid' : ''}`}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy('title')}
            {...titleField}
            onChange={(e) => {
              void titleField.onChange(e);
              if (!slugTouched) setValue('slug', slugify(e.target.value));
            }}
          />
          {errors.title && (
            <div id={`${id}-title-error`} className="invalid-feedback">
              {fieldError(t, errors.title.message)}
            </div>
          )}
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-slug`} className="form-label small">
            {t('library.slug')}
          </label>
          <input
            id={`${id}-slug`}
            className={`form-control form-control-sm font-monospace ${errors.slug ? 'is-invalid' : ''}`}
            spellCheck={false}
            aria-invalid={errors.slug ? true : undefined}
            aria-describedby={describedBy('slug', `${id}-slug-hint`)}
            {...slugField}
            onChange={(e) => {
              setSlugTouched(true);
              void slugField.onChange(e);
            }}
          />
          {errors.slug && (
            <div id={`${id}-slug-error`} className="invalid-feedback">
              {fieldError(t, errors.slug.message)}
            </div>
          )}
          <div id={`${id}-slug-hint`} className="form-text">
            {t('library.slugHint')}
          </div>
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-family`} className="form-label small">
            {t('library.roles.family')}
          </label>
          <select
            id={`${id}-family`}
            className="form-select form-select-sm"
            {...register('family')}
          >
            {RoleFamily.options.map((f) => (
              <option key={f} value={f}>
                {t(`library.families.${f}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-seniority`} className="form-label small">
            {t('library.roles.defaultSeniority')}
          </label>
          <select
            id={`${id}-seniority`}
            className="form-select form-select-sm"
            {...register('defaultSeniority')}
          >
            {Seniority.options.map((s) => (
              <option key={s} value={s}>
                {t(`library.seniority.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-aliases`} className="form-label small">
            {t('library.roles.aliases')}
          </label>
          <input
            id={`${id}-aliases`}
            className={`form-control form-control-sm ${errors.aliases ? 'is-invalid' : ''}`}
            aria-invalid={errors.aliases ? true : undefined}
            aria-describedby={describedBy('aliases', `${id}-aliases-hint`)}
            {...register('aliases')}
          />
          {errors.aliases && (
            <div id={`${id}-aliases-error`} className="invalid-feedback">
              {fieldError(t, errors.aliases.message)}
            </div>
          )}
          <div id={`${id}-aliases-hint`} className="form-text">
            {t('library.roles.aliasesHint')}
          </div>
        </div>
        <div className="col-12">
          <div className="form-check form-switch">
            <input
              id={`${id}-active`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('active')}
            />
            <label htmlFor={`${id}-active`} className="form-check-label">
              {t('library.roles.activeField')}
            </label>
          </div>
        </div>
      </div>
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {role ? t('library.roles.save') : t('library.roles.create')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => onDone(null)}
        >
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('library.manage');
  const [editing, setEditing] = useState<RoleSummary | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const roles = useRoles();
  // One request resolves every role's active version number for the table.
  const canonical = useQuery({
    queryKey: ['library', 'blueprints', 'CANONICAL'],
    queryFn: () =>
      manager.api.get<BlueprintSummary[]>('/admin/blueprints?origin=CANONICAL&limit=100'),
  });
  const versionOf = new Map((canonical.data ?? []).map((b) => [b.id, b.version]));

  return (
    <>
      <h1 className="h3 mb-2">{t('library.roles.title')}</h1>
      <p className="cb-text-secondary">{t('library.roles.subtitle')}</p>
      <RolesTabs />
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => {
            setNotice(null);
            setEditing('new');
          }}
        >
          {t('library.roles.new')}
        </button>
      )}
      {editing !== null && (
        <RoleEditor
          key={editing === 'new' ? 'new' : editing.id}
          role={editing === 'new' ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) setNotice(t('library.roles.saved', { title: saved.title }));
          }}
        />
      )}
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('library.roles.listLabel')}
      >
        {roles.isPending && <LoadingRow />}
        {roles.isError && (
          <div className="m-3">
            <ErrorAlert error={libraryError(t, roles.error)} />
          </div>
        )}
        {roles.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.roles.titleField')}</th>
                  <th scope="col">{t('library.slug')}</th>
                  <th scope="col">{t('library.roles.family')}</th>
                  <th scope="col">{t('library.roles.defaultSeniority')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('library.roles.activeBlueprint')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.data.length === 0 && (
                  <tr>
                    <td colSpan={7} className="cb-text-secondary">
                      {t('library.roles.empty')}
                    </td>
                  </tr>
                )}
                {roles.data.map((role) => (
                  <tr key={role.id}>
                    <th scope="row">
                      <Link to={`/roles/${role.id}`}>{role.title}</Link>
                      {role.aliases.length > 0 && (
                        <div className="small cb-text-secondary fw-normal">
                          {role.aliases.join(', ')}
                        </div>
                      )}
                    </th>
                    <td>
                      <code>{role.slug}</code>
                    </td>
                    <td>{t(`library.families.${role.family}`)}</td>
                    <td>{t(`library.seniority.${role.defaultSeniority}`)}</td>
                    <td>
                      <ActiveBadge active={role.active} />
                    </td>
                    <td>
                      {role.activeBlueprintId === null ? (
                        <span className="badge text-bg-warning">
                          {t('library.roles.noBlueprint')}
                        </span>
                      ) : versionOf.has(role.activeBlueprintId) ? (
                        t('library.version', { n: versionOf.get(role.activeBlueprintId) })
                      ) : (
                        t('library.roles.hasBlueprint')
                      )}
                    </td>
                    <td className="text-end text-nowrap">
                      {canManage && editing === null && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          aria-label={t('library.roles.editLabel', { title: role.title })}
                          onClick={() => {
                            setNotice(null);
                            setEditing(role);
                          }}
                        >
                          {t('library.edit')}
                        </button>
                      )}
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
