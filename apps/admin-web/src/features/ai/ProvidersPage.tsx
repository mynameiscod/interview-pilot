import type { AiProviderSummary } from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from './shared';
import { consoleError, providerName } from './format';

type Mode = 'view' | 'key' | 'removeKey' | 'toggle';

function ProviderRow({ provider, canManage }: { provider: AiProviderSummary; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setMode('view');
    setApiKey('');
    setError(null);
  };
  const save = useMutation({
    mutationFn: (reason: string) => {
      const path = `/admin/ai/providers/${provider.id}`;
      if (mode === 'key') return manager.api.put(`${path}/credential`, { apiKey, reason });
      if (mode === 'removeKey') return manager.api.delete(`${path}/credential`, { reason });
      return manager.api.patch(path, { enabled: !provider.enabled });
    },
    onSuccess: async () => {
      close();
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
    },
    // The key never lingers in memory after a failed attempt either.
    onError: (err) => {
      setApiKey('');
      setError(consoleError(t, err));
    },
  });

  // The server's display name wins; the key-based label covers blank names.
  const name = provider.displayName.trim() || providerName(t, provider.key);
  const keyHintKey = `ai.providers.keyHints.${provider.key}`;

  const updated = provider.credential
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
        new Date(provider.credential.updatedAt),
      )
    : null;

  return (
    <>
      <tr>
        <th scope="row">
          <div className="fw-semibold">{name}</div>
          <code className="small">{provider.key}</code>
        </th>
        <td>
          <span className={`badge ${provider.enabled ? 'text-bg-success' : 'text-bg-secondary'}`}>
            {provider.enabled ? t('ai.enabled') : t('ai.disabled')}
          </span>
        </td>
        <td>
          {provider.key === 'mock' ? (
            <span className="small cb-text-secondary">{t('ai.providers.mockNoKey')}</span>
          ) : provider.credential ? (
            <span className="small">
              <i className="bi bi-key me-1" aria-hidden="true" />
              {t('ai.providers.keyEnding', { last4: provider.credential.last4 })}
              <span className="d-block cb-text-secondary">
                {t('ai.providers.keyUpdated', { date: updated, keyId: provider.credential.keyId })}
              </span>
            </span>
          ) : (
            <span className="badge text-bg-warning">{t('ai.providers.noKey')}</span>
          )}
        </td>
        <td className="text-end text-nowrap">
          {canManage && mode === 'view' && (
            <div className="d-flex flex-wrap gap-2 justify-content-end">
              {provider.key !== 'mock' && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={() => setMode('key')}
                >
                  {provider.credential ? t('ai.providers.replaceKey') : t('ai.providers.setKey')}
                </button>
              )}
              {provider.credential && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  onClick={() => setMode('removeKey')}
                >
                  {t('ai.providers.removeKey')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setMode('toggle')}
              >
                {provider.enabled ? t('ai.disable') : t('ai.enable')}
              </button>
            </div>
          )}
        </td>
      </tr>
      {mode !== 'view' && (
        <tr>
          <td colSpan={4}>
            {mode === 'toggle' ? (
              <div className="p-3 cb-surface-muted rounded-2 d-flex flex-wrap gap-2 align-items-center">
                <span>
                  {provider.enabled
                    ? t('ai.providers.disableExplain', { name })
                    : t('ai.providers.enableExplain', { name })}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={save.isPending}
                  onClick={() => save.mutate('')}
                >
                  {provider.enabled ? t('ai.disable') : t('ai.enable')}
                </button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={close}>
                  {t('ai.cancel')}
                </button>
                <ErrorAlert error={error} />
              </div>
            ) : (
              <ReasonForm
                submitLabel={
                  mode === 'key' ? t('ai.providers.saveKey') : t('ai.providers.confirmRemoveKey')
                }
                danger={mode === 'removeKey'}
                pending={save.isPending}
                error={error}
                disabled={mode === 'key' && apiKey.trim().length < 8}
                onSubmit={(reason) => save.mutate(reason)}
                onCancel={close}
              >
                {mode === 'key' ? (
                  <div className="mb-3">
                    <label htmlFor={`${id}-key`} className="form-label">
                      {t('ai.providers.apiKey', { name })}
                    </label>
                    <input
                      id={`${id}-key`}
                      type="password"
                      className="form-control"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    {i18n.exists(keyHintKey) && <div className="form-text">{t(keyHintKey)}</div>}
                    <div className="form-text">{t('ai.providers.keyHint')}</div>
                  </div>
                ) : (
                  <p>{t('ai.providers.removeExplain', { name })}</p>
                )}
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ProvidersPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('ai.manage');
  const providers = useQuery({
    queryKey: ['ai', 'providers'],
    queryFn: () => manager.api.get<AiProviderSummary[]>('/admin/ai/providers'),
  });

  return (
    <section className="border cb-border rounded-3 bg-white" aria-label={t('ai.tabs.providers')}>
      {providers.isPending && <LoadingRow />}
      {providers.isError && (
        <div className="m-3">
          <ErrorAlert error={consoleError(t, providers.error)} />
        </div>
      )}
      {providers.data && (
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead>
              <tr>
                <th scope="col">{t('ai.providers.provider')}</th>
                <th scope="col">{t('ai.status')}</th>
                <th scope="col">{t('ai.providers.key')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('ai.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.data.map((p) => (
                <ProviderRow key={p.id} provider={p} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
