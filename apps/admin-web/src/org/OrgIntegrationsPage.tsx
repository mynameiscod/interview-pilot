import {
  WebhookEvent,
  type ApiKeyWithSecret,
  type WebhookSummary,
  type WebhookWithSecret,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleError } from '../features/ai/format';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { formatDateTime } from '../features/library/format';
import { orgKeys, useApiKeys, useDeliveries, useWebhooks } from './queries';
import { useOrgAuth } from './session';
import { ShownOnce } from './shared';

function DeliveryLog({ webhook }: { webhook: WebhookSummary }) {
  const { t, i18n } = useTranslation();
  const deliveries = useDeliveries(webhook.id);
  if (deliveries.isPending) return <LoadingRow />;
  if (deliveries.isError) return <ErrorAlert error={consoleError(t, deliveries.error)} />;
  if (deliveries.data.length === 0) {
    return <p className="small mb-0">{t('orgPortal.integrations.noDeliveries')}</p>;
  }
  return (
    <div className="table-responsive">
      <table className="table table-sm small mb-0">
        <caption className="visually-hidden">{t('orgPortal.integrations.log')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('orgPortal.integrations.event')}</th>
            <th scope="col">{t('orgPortal.team.status')}</th>
            <th scope="col">{t('orgPortal.integrations.attempts')}</th>
            <th scope="col">{t('orgPortal.integrations.response')}</th>
            <th scope="col">{t('orgPortal.integrations.when')}</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.data.map((d) => (
            <tr key={d.id}>
              <td className="font-monospace">{d.event}</td>
              <td>{t(`orgPortal.integrations.deliveryStatus.${d.status}`)}</td>
              <td>{d.attempts}</td>
              <td>{d.lastStatusCode ?? d.lastError ?? '—'}</td>
              <td>{formatDateTime(d.deliveredAt ?? d.createdAt, i18n.language)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Webhooks() {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const webhooks = useWebhooks();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([...WebhookEvent.options]);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orgKeys.webhooks });

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await manager.api.post<WebhookWithSecret>('/org/webhooks', {
        url: url.trim(),
        events,
        description: null,
      });
      setSecret(created.secret);
      setUrl('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  async function act(hook: WebhookSummary, action: 'ping' | 'toggle' | 'delete') {
    setError(null);
    try {
      if (action === 'ping') {
        await manager.api.post(`/org/webhooks/${hook.id}/ping`);
        setOpen(hook.id);
        await queryClient.invalidateQueries({ queryKey: orgKeys.deliveries(hook.id) });
      } else if (action === 'toggle') {
        await manager.api.put(`/org/webhooks/${hook.id}`, {
          events: hook.events,
          active: !hook.active,
          description: hook.description,
        });
      } else {
        await manager.api.delete(`/org/webhooks/${hook.id}`);
      }
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <section className="mb-4" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="h5">
        {t('orgPortal.integrations.webhooks')}
      </h2>
      <p className="small cb-text-secondary">{t('orgPortal.integrations.webhooksIntro')}</p>
      {secret && (
        <ShownOnce
          label={t('orgPortal.integrations.secret')}
          value={secret}
          onDismiss={() => setSecret(null)}
        />
      )}
      <form className="row g-2 align-items-end mb-3" onSubmit={(e) => void create(e)}>
        <div className="col-md-6">
          <label htmlFor={`${id}-url`} className="form-label small">
            {t('orgPortal.integrations.url')}
          </label>
          <input
            id={`${id}-url`}
            type="url"
            required
            placeholder="https://"
            className="form-control form-control-sm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <fieldset className="col-md-4">
          <legend className="form-label small mb-1">{t('orgPortal.integrations.events')}</legend>
          {WebhookEvent.options.map((ev) => (
            <div className="form-check" key={ev}>
              <input
                id={`${id}-${ev}`}
                type="checkbox"
                className="form-check-input"
                checked={events.includes(ev)}
                onChange={() =>
                  setEvents((list) =>
                    list.includes(ev) ? list.filter((x) => x !== ev) : [...list, ev],
                  )
                }
              />
              <label htmlFor={`${id}-${ev}`} className="form-check-label small font-monospace">
                {ev}
              </label>
            </div>
          ))}
        </fieldset>
        <div className="col-auto">
          <button type="submit" className="btn btn-sm btn-primary" disabled={events.length === 0}>
            {t('orgPortal.integrations.addWebhook')}
          </button>
        </div>
      </form>
      <ErrorAlert error={error} />
      {webhooks.isPending ? (
        <LoadingRow />
      ) : (
        <ul className="list-unstyled">
          {(webhooks.data ?? []).map((hook) => (
            <li key={hook.id} className="p-3 border cb-border rounded-3 bg-white mb-2">
              <div className="d-flex flex-wrap justify-content-between gap-2">
                <div>
                  <div className="font-monospace small text-break">{hook.url}</div>
                  <div className="small cb-text-secondary">
                    {hook.events.join(', ')} ·{' '}
                    {hook.active
                      ? t('orgPortal.integrations.active')
                      : t('orgPortal.integrations.paused')}{' '}
                    · {t('orgPortal.integrations.secretHint', { hint: hook.secretHint })}
                  </div>
                </div>
                <div className="d-flex gap-1 align-items-start">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-primary"
                    onClick={() => void act(hook, 'ping')}
                  >
                    {t('orgPortal.integrations.ping')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    aria-expanded={open === hook.id}
                    onClick={() => setOpen(open === hook.id ? null : hook.id)}
                  >
                    {t('orgPortal.integrations.log')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => void act(hook, 'toggle')}
                  >
                    {hook.active
                      ? t('orgPortal.integrations.pause')
                      : t('orgPortal.integrations.resume')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    onClick={() => void act(hook, 'delete')}
                  >
                    {t('orgPortal.integrations.delete')}
                  </button>
                </div>
              </div>
              {open === hook.id && (
                <div className="mt-2">
                  <DeliveryLog webhook={hook} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApiKeys() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useOrgAuth();
  const queryClient = useQueryClient();
  const keys = useApiKeys();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: orgKeys.apiKeys });

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await manager.api.post<ApiKeyWithSecret>('/org/api-keys', {
        name: name.trim(),
      });
      setCreated(result.key);
      setName('');
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  async function revoke(keyId: string) {
    setError(null);
    try {
      await manager.api.post(`/org/api-keys/${keyId}/revoke`);
      await refresh();
    } catch (err) {
      setError(consoleError(t, err));
    }
  }

  return (
    <section className="mb-4" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="h5">
        {t('orgPortal.integrations.apiKeys')}
      </h2>
      <p className="small cb-text-secondary">{t('orgPortal.integrations.apiKeysIntro')}</p>
      {created && (
        <ShownOnce
          label={t('orgPortal.integrations.key')}
          value={created}
          onDismiss={() => setCreated(null)}
        />
      )}
      <form className="row g-2 align-items-end mb-3" onSubmit={(e) => void create(e)}>
        <div className="col-md-5">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('orgPortal.integrations.keyName')}
          </label>
          <input
            id={`${id}-name`}
            required
            minLength={2}
            className="form-control form-control-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="col-auto">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('orgPortal.integrations.createKey')}
          </button>
        </div>
      </form>
      <ErrorAlert error={error} />
      {keys.isPending ? (
        <LoadingRow />
      ) : (
        <div className="table-responsive border cb-border rounded-3 bg-white">
          <table className="table table-sm small align-middle mb-0">
            <caption className="visually-hidden">{t('orgPortal.integrations.apiKeys')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('orgPortal.integrations.keyName')}</th>
                <th scope="col">{t('orgPortal.integrations.prefix')}</th>
                <th scope="col">{t('orgPortal.integrations.lastUsed')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('orgPortal.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(keys.data ?? []).map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="font-monospace">{k.prefix}…</td>
                  <td>{formatDateTime(k.lastUsedAt, i18n.language) || '—'}</td>
                  <td className="text-end">
                    {k.revokedAt ? (
                      t('orgPortal.integrations.revoked')
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        onClick={() => void revoke(k.id)}
                      >
                        {t('orgPortal.integrations.revoke')}
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
  );
}

/** Webhooks and API keys for applicant tracking systems (owners only). */
export function OrgIntegrationsPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="h3">{t('orgPortal.integrations.title')}</h1>
      <p className="cb-text-secondary">{t('orgPortal.integrations.intro')}</p>
      <Webhooks />
      <ApiKeys />
      <section className="p-3 cb-surface-muted rounded-3" aria-labelledby="org-ats">
        <h2 id="org-ats" className="h6">
          {t('orgPortal.integrations.atsTitle')}
        </h2>
        <p className="small mb-0">{t('orgPortal.integrations.atsBody')}</p>
      </section>
    </>
  );
}
