import type { BlueprintSummary } from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime, libraryError } from './format';
import { useRoles } from './queries';
import { BlueprintMeta, BlueprintViewer, RolesTabs } from './shared';

/** Recent blueprints generated for candidates' job targets, for review. */
export function AiBlueprintsPage() {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const list = useQuery({
    queryKey: ['library', 'blueprints', 'AI_GENERATED'],
    queryFn: () =>
      manager.api.get<BlueprintSummary[]>('/admin/blueprints?origin=AI_GENERATED&limit=50'),
  });

  return (
    <>
      <h1 className="h3 mb-2">{t('library.roles.title')}</h1>
      <p className="cb-text-secondary">{t('library.aiBlueprints.subtitle')}</p>
      <RolesTabs />
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('library.aiBlueprints.listLabel')}
      >
        {list.isPending && <LoadingRow />}
        {list.isError && (
          <div className="m-3">
            <ErrorAlert error={libraryError(t, list.error)} />
          </div>
        )}
        {list.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.aiBlueprints.roleTitle')}</th>
                  <th scope="col">{t('library.roles.family')}</th>
                  <th scope="col">{t('library.aiBlueprints.seniority')}</th>
                  <th scope="col">{t('library.aiBlueprints.model')}</th>
                  <th scope="col">{t('library.created')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="cb-text-secondary">
                      {t('library.aiBlueprints.empty')}
                    </td>
                  </tr>
                )}
                {list.data.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{b.content.role.title}</th>
                    <td>{t(`library.families.${b.content.role.family}`)}</td>
                    <td>{t(`library.seniority.${b.content.role.seniority}`)}</td>
                    <td className="small">
                      {b.generatedBy ? (
                        <>
                          <code>{b.generatedBy.model}</code>
                          {b.generatedBy.promptVersion !== null && (
                            <span className="cb-text-secondary ms-1">
                              {t('library.aiBlueprints.prompt', {
                                version: t('library.version', { n: b.generatedBy.promptVersion }),
                              })}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="small">{formatDateTime(b.createdAt, i18n.language)}</td>
                    <td className="text-end">
                      <Link
                        to={`/blueprints/${b.id}`}
                        className="btn btn-sm btn-outline-secondary"
                        aria-label={t('library.aiBlueprints.reviewLabel', {
                          title: b.content.role.title,
                        })}
                      >
                        {t('library.aiBlueprints.review')}
                      </Link>
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

function PromoteForm({ blueprint }: { blueprint: BlueprintSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const promote = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<BlueprintSummary>(`/admin/blueprints/${blueprint.id}/promote`, {
        roleId,
        reason,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      void navigate(`/roles/${created.roleId}?version=${created.id}`);
    },
    onError: (err) => setError(libraryError(t, err)),
  });

  if (!open) {
    return (
      <button type="button" className="btn btn-sm btn-primary mb-3" onClick={() => setOpen(true)}>
        {t('library.aiBlueprints.promote')}
      </button>
    );
  }
  return (
    <div className="mb-3">
      <ReasonForm
        submitLabel={t('library.aiBlueprints.confirmPromote')}
        pending={promote.isPending}
        error={error}
        disabled={!roleId}
        onSubmit={(reason) => promote.mutate(reason)}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
      >
        <p>{t('library.aiBlueprints.promoteExplain')}</p>
        <label htmlFor={`${id}-role`} className="form-label">
          {t('library.aiBlueprints.targetRole')}
        </label>
        <select
          id={`${id}-role`}
          className="form-select mb-3"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          required
        >
          <option value="">{t('library.aiBlueprints.chooseRole')}</option>
          {(roles.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </ReasonForm>
    </div>
  );
}

export function AiBlueprintPage() {
  const { t } = useTranslation();
  const { blueprintId = '' } = useParams();
  const { manager } = useAdminAuth();
  const canManage = useCan('library.manage');
  const blueprint = useQuery({
    queryKey: ['library', 'blueprint', blueprintId],
    queryFn: () => manager.api.get<BlueprintSummary>(`/admin/blueprints/${blueprintId}`),
  });

  return (
    <>
      <Link to="/blueprints" className="small">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        {t('library.aiBlueprints.back')}
      </Link>
      {blueprint.isPending && <LoadingRow />}
      {blueprint.isError && (
        <div className="mt-3">
          <ErrorAlert error={libraryError(t, blueprint.error)} />
        </div>
      )}
      {blueprint.data && (
        <>
          <h1 className="h3 mt-2 mb-1">
            {t('library.aiBlueprints.detailTitle', { title: blueprint.data.content.role.title })}
          </h1>
          <BlueprintMeta blueprint={blueprint.data} />
          {canManage && blueprint.data.origin === 'AI_GENERATED' && (
            <PromoteForm blueprint={blueprint.data} />
          )}
          <section className="p-3 border cb-border rounded-3 bg-white">
            <BlueprintViewer
              content={blueprint.data.content}
              label={t('library.aiBlueprints.viewerLabel')}
            />
          </section>
        </>
      )}
    </>
  );
}
