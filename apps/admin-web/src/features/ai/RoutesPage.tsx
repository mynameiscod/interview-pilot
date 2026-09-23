import type { AiModelSummary, AiRouteSummary } from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from './shared';
import { consoleError } from './format';

function RouteEditor({
  route,
  models,
  onDone,
}: {
  route: AiRouteSummary;
  models: AiModelSummary[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [active, setActive] = useState(route.active);
  const [chain, setChain] = useState(route.chain.map((c) => c.modelId));
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const eligible = models.filter((m) => m.capabilities.includes(route.capability));
  const label = (modelId: string) => {
    const m = models.find((x) => x.id === modelId);
    return m ? `${m.displayName} (${m.providerKey})` : t('ai.routes.deletedModel');
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...chain];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    setChain(next);
  };
  const save = useMutation({
    mutationFn: (reason: string) =>
      manager.api.put(`/admin/ai/routes/${route.feature}`, {
        active,
        chain: chain.map((modelId, priority) => ({ modelId, priority })),
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      onDone();
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <ReasonForm
      submitLabel={t('ai.routes.save')}
      pending={save.isPending}
      error={error}
      disabled={active && chain.length === 0}
      onSubmit={(reason) => save.mutate(reason)}
      onCancel={onDone}
    >
      <div className="form-check form-switch mb-2">
        <input
          id={`${id}-active`}
          type="checkbox"
          role="switch"
          className="form-check-input"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <label htmlFor={`${id}-active`} className="form-check-label">
          {t('ai.routes.active')}
        </label>
      </div>
      <ol
        className="list-group list-group-numbered mb-2"
        aria-label={t('ai.routes.chainLabel', { feature: route.feature })}
      >
        {chain.map((modelId, index) => (
          <li key={modelId} className="list-group-item d-flex align-items-center gap-2">
            <span className="flex-grow-1">{label(modelId)}</span>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-label={t('ai.routes.moveUp', { model: label(modelId) })}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <i className="bi bi-arrow-up" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-label={t('ai.routes.moveDown', { model: label(modelId) })}
              disabled={index === chain.length - 1}
              onClick={() => move(index, 1)}
            >
              <i className="bi bi-arrow-down" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              aria-label={t('ai.routes.remove', { model: label(modelId) })}
              onClick={() => setChain(chain.filter((m) => m !== modelId))}
            >
              <i className="bi bi-x-lg" aria-hidden="true" />
            </button>
          </li>
        ))}
        {chain.length === 0 && (
          <li className="list-group-item cb-text-secondary">{t('ai.routes.empty')}</li>
        )}
      </ol>
      <div className="d-flex gap-2 mb-3">
        <label htmlFor={`${id}-add`} className="visually-hidden">
          {t('ai.routes.addModel')}
        </label>
        <select
          id={`${id}-add`}
          className="form-select form-select-sm"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        >
          <option value="">{t('ai.routes.addModel')}</option>
          {eligible
            .filter((m) => !chain.includes(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} ({m.providerKey}){m.enabled ? '' : ` — ${t('ai.disabled')}`}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn btn-sm btn-outline-primary text-nowrap"
          disabled={!adding}
          onClick={() => {
            setChain([...chain, adding]);
            setAdding('');
          }}
        >
          {t('ai.routes.add')}
        </button>
      </div>
      <p className="small cb-text-secondary">{t('ai.routes.hint')}</p>
    </ReasonForm>
  );
}

export function RoutesPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('ai.manage');
  const [editing, setEditing] = useState<string | null>(null);
  const routes = useQuery({
    queryKey: ['ai', 'routes'],
    queryFn: () => manager.api.get<AiRouteSummary[]>('/admin/ai/routes'),
  });
  const models = useQuery({
    queryKey: ['ai', 'models'],
    queryFn: () => manager.api.get<AiModelSummary[]>('/admin/ai/models'),
  });

  return (
    <section className="border cb-border rounded-3 bg-white" aria-label={t('ai.tabs.routes')}>
      {(routes.isPending || models.isPending) && <LoadingRow />}
      {(routes.isError || models.isError) && (
        <div className="m-3">
          <ErrorAlert error={consoleError(t, routes.error ?? models.error)} />
        </div>
      )}
      {routes.data && models.data && (
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead>
              <tr>
                <th scope="col">{t('ai.routes.feature')}</th>
                <th scope="col">{t('ai.routes.chain')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('ai.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {routes.data.map((route) => (
                <FeatureRow
                  key={route.feature}
                  route={route}
                  models={models.data}
                  canManage={canManage}
                  editing={editing === route.feature}
                  onEdit={() => setEditing(route.feature)}
                  onDone={() => setEditing(null)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FeatureRow({
  route,
  models,
  canManage,
  editing,
  onEdit,
  onDone,
}: {
  route: AiRouteSummary;
  models: AiModelSummary[];
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr>
        <th scope="row">
          <code>{route.feature}</code>
          <div className="small cb-text-secondary">
            {t(`ai.features.${route.feature.replace('.', '_')}`)}
          </div>
        </th>
        <td>
          {!route.active ? (
            <span className="badge text-bg-secondary">{t('ai.routes.inactive')}</span>
          ) : route.chain.length === 0 ? (
            <span className="badge text-bg-warning">{t('ai.routes.notConfigured')}</span>
          ) : (
            <ol className="small mb-0 ps-3">
              {route.chain.map((c) => (
                <li key={c.modelId}>{c.label}</li>
              ))}
            </ol>
          )}
        </td>
        <td className="text-end">
          {canManage && !editing && (
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={onEdit}>
              {t('ai.routes.edit')}
            </button>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={3}>
            <RouteEditor route={route} models={models} onDone={onDone} />
          </td>
        </tr>
      )}
    </>
  );
}
