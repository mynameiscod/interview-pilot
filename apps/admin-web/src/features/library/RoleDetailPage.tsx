import type { BlueprintSummary, RoleSummary } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { BlueprintEditor } from './BlueprintEditor';
import { diffBlueprints } from './blueprint-diff';
import { formatDateTime, libraryError } from './format';
import { useRoleBlueprints, useRoles } from './queries';
import {
  ActiveBadge,
  BlueprintDiffView,
  BlueprintMeta,
  BlueprintViewer,
  StatusBadge,
} from './shared';

type Panel = { id: string; mode: 'view' | 'diff' | 'activate' } | null;

/** Content for a role that has no blueprint yet: the editor validates the rest. */
const skeleton = (role: RoleSummary) => ({
  schemaVersion: 1,
  role: { title: role.title, family: role.family, seniority: role.defaultSeniority, summary: '' },
  competencies: [],
  focusSkills: [],
  probeAreas: [],
  notes: null,
});

function VersionRow({
  blueprint,
  active,
  panel,
  setPanel,
  canManage,
  editing,
  onActivated,
}: {
  blueprint: BlueprintSummary;
  active: BlueprintSummary | undefined;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onActivated: (b: BlueprintSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === blueprint.id ? panel.mode : null;
  const activate = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<BlueprintSummary>(`/admin/blueprints/${blueprint.id}/activate`, {
        reason,
      }),
    onSuccess: async () => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      onActivated(blueprint);
    },
    onError: (err) => setError(libraryError(t, err)),
  });
  const diff = useMemo(
    () => (mode === 'diff' && active ? diffBlueprints(active.content, blueprint.content) : null),
    [mode, active, blueprint],
  );
  const versionLabel = t('library.version', { n: blueprint.version });
  const toggle = (next: 'view' | 'diff') =>
    setPanel(mode === next ? null : { id: blueprint.id, mode: next });

  return (
    <>
      <tr>
        <th scope="row">{versionLabel}</th>
        <td>
          <StatusBadge status={blueprint.status} />
        </td>
        <td className="small">{t(`library.origin.${blueprint.origin}`)}</td>
        <td className="small">{formatDateTime(blueprint.createdAt, i18n.language)}</td>
        <td className="small">
          {blueprint.activatedAt ? formatDateTime(blueprint.activatedAt, i18n.language) : '—'}
        </td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('library.blueprints.viewLabel', { version: versionLabel })}
              onClick={() => toggle('view')}
            >
              {mode === 'view' ? t('library.hide') : t('library.view')}
            </button>
            {active && active.id !== blueprint.id && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                aria-expanded={mode === 'diff'}
                aria-label={t('library.blueprints.compareLabel', { version: versionLabel })}
                onClick={() => toggle('diff')}
              >
                {t('library.blueprints.compare')}
              </button>
            )}
            {canManage && !editing && blueprint.status !== 'ACTIVE' && mode !== 'activate' && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                aria-label={t(
                  blueprint.status === 'RETIRED'
                    ? 'library.rollbackLabel'
                    : 'library.activateLabel',
                  { version: versionLabel },
                )}
                onClick={() => {
                  setError(null);
                  setPanel({ id: blueprint.id, mode: 'activate' });
                }}
              >
                {blueprint.status === 'RETIRED' ? t('library.rollback') : t('library.activate')}
              </button>
            )}
          </div>
        </td>
      </tr>
      {mode && (
        <tr>
          <td colSpan={6}>
            {mode === 'view' && (
              <>
                <BlueprintMeta blueprint={blueprint} />
                <BlueprintViewer
                  content={blueprint.content}
                  label={t('library.blueprints.viewerLabel', { version: versionLabel })}
                />
              </>
            )}
            {mode === 'diff' && diff && active && (
              <BlueprintDiffView
                diff={diff}
                baseVersion={active.version}
                label={t('library.diff.label', { version: versionLabel, n: active.version })}
              />
            )}
            {mode === 'activate' && (
              <ReasonForm
                submitLabel={t('library.confirmActivate', { version: versionLabel })}
                pending={activate.isPending}
                error={error}
                onSubmit={(reason) => activate.mutate(reason)}
                onCancel={() => {
                  setPanel(null);
                  setError(null);
                }}
              >
                <p>
                  {active
                    ? t('library.blueprints.activateExplain', {
                        version: versionLabel,
                        n: active.version,
                      })
                    : t('library.blueprints.activateFirst', { version: versionLabel })}
                </p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function RoleDetailPage() {
  const { t } = useTranslation();
  const { roleId = '' } = useParams();
  const [params] = useSearchParams();
  const canManage = useCan('library.manage');
  const roles = useRoles();
  const blueprints = useRoleBlueprints(roleId);
  const highlighted = params.get('version');
  const [panel, setPanel] = useState<Panel>(highlighted ? { id: highlighted, mode: 'view' } : null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const role = roles.data?.find((r) => r.id === roleId);
  const active = blueprints.data?.find((b) => b.status === 'ACTIVE');

  if (roles.isPending) return <LoadingRow />;
  if (roles.isError) return <ErrorAlert error={libraryError(t, roles.error)} />;
  if (!role) {
    return (
      <>
        <h1 className="h3">{t('library.roles.notFound')}</h1>
        <Link to="/roles">{t('library.roles.back')}</Link>
      </>
    );
  }

  const latest = blueprints.data?.[0];
  return (
    <>
      <Link to="/roles" className="small">
        <i className="bi bi-arrow-left me-1" aria-hidden="true" />
        {t('library.roles.back')}
      </Link>
      <h1 className="h3 mt-2 mb-1">{role.title}</h1>
      <p className="cb-text-secondary">
        <code>{role.slug}</code> · {t(`library.families.${role.family}`)} ·{' '}
        {t(`library.seniority.${role.defaultSeniority}`)} · <ActiveBadge active={role.active} />
      </p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && !editing && blueprints.data && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => {
            setNotice(null);
            setPanel(null);
            setEditing(true);
          }}
        >
          {t('library.blueprints.new')}
        </button>
      )}
      {editing && (
        <BlueprintEditor
          roleId={role.id}
          initial={(active ?? latest)?.content ?? skeleton(role)}
          onDone={(created) => {
            setEditing(false);
            if (created) {
              setNotice(
                t('library.blueprints.saved', {
                  version: t('library.version', { n: created.version }),
                }),
              );
              setPanel({ id: created.id, mode: 'view' });
            }
          }}
        />
      )}
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('library.blueprints.historyLabel')}
      >
        <h2 className="h6 p-3 mb-0">{t('library.blueprints.history')}</h2>
        {blueprints.isPending && <LoadingRow />}
        {blueprints.isError && (
          <div className="m-3">
            <ErrorAlert error={libraryError(t, blueprints.error)} />
          </div>
        )}
        {blueprints.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.versionHeader')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('library.blueprints.origin')}</th>
                  <th scope="col">{t('library.created')}</th>
                  <th scope="col">{t('library.activated')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {blueprints.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="cb-text-secondary">
                      {t('library.blueprints.empty')}
                    </td>
                  </tr>
                )}
                {blueprints.data.map((b) => (
                  <VersionRow
                    key={b.id}
                    blueprint={b}
                    active={active}
                    panel={panel}
                    setPanel={setPanel}
                    canManage={canManage}
                    editing={editing}
                    onActivated={(activated) =>
                      setNotice(
                        t('library.blueprints.activated', {
                          version: t('library.version', { n: activated.version }),
                          title: role.title,
                        }),
                      )
                    }
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
