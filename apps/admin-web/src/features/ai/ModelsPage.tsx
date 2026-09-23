import {
  AiCapability,
  PricingUnit,
  type AiModelParams,
  type AiModelSummary,
  type AiProviderSummary,
  type TestAiModelResponse,
} from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from './shared';
import { consoleError, formatMicros, microsToDecimal } from './format';

type Mode = 'view' | 'params' | 'price' | 'toggle';

const PARAM_FIELDS: { key: keyof Omit<AiModelParams, 'temperature'>; min: number; max: number }[] =
  [
    { key: 'maxOutputTokens', min: 16, max: 128_000 },
    { key: 'timeoutMs', min: 1000, max: 600_000 },
    { key: 'retries', min: 0, max: 5 },
    { key: 'concurrency', min: 1, max: 500 },
  ];

function ModelRow({ model, canManage }: { model: AiModelSummary; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState(model.params);
  const [price, setPrice] = useState({
    unit: 'PER_1M_INPUT_TOKENS' as PricingUnit,
    amount: '',
    effectiveFrom: '',
  });
  const [test, setTest] = useState<TestAiModelResponse | null>(null);

  const close = () => {
    setMode('view');
    setError(null);
    setParams(model.params);
  };
  const path = `/admin/ai/models/${model.id}`;
  const save = useMutation({
    mutationFn: (reason: string) => {
      if (mode === 'price') {
        return manager.api.post(`${path}/prices`, {
          unit: price.unit,
          price: price.amount,
          currency: model.currentPricing[0]?.currency ?? model.pricing[0]?.currency ?? 'USD',
          ...(price.effectiveFrom
            ? { effectiveFrom: new Date(price.effectiveFrom).toISOString() }
            : {}),
          reason,
        });
      }
      if (mode === 'params') return manager.api.patch(path, { params });
      return manager.api.patch(path, { enabled: !model.enabled });
    },
    onSuccess: async () => {
      setMode('view');
      setError(null);
      setPrice({ unit: 'PER_1M_INPUT_TOKENS', amount: '', effectiveFrom: '' });
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
    },
    onError: (err) => setError(consoleError(t, err)),
  });
  const runTest = useMutation({
    mutationFn: () => manager.api.post<TestAiModelResponse>(`${path}/test`),
    onSuccess: setTest,
    onError: (err) => setError(consoleError(t, err)),
  });

  const priceOf = (unit: PricingUnit) => model.currentPricing.find((p) => p.unit === unit);
  const money = (unit: PricingUnit) => {
    const p = priceOf(unit);
    return p ? formatMicros(p.pricePerUnitMicros, p.currency, i18n.language) : '—';
  };
  // Entries newer than the price in force for their unit have not taken effect yet.
  const upcoming = model.pricing.filter((p) => {
    const current = priceOf(p.unit);
    return !current || p.effectiveFrom > current.effectiveFrom;
  });

  return (
    <>
      <tr>
        <th scope="row">
          <div className="fw-semibold">{model.displayName}</div>
          <code className="small">
            {model.providerKey} / {model.modelId}
          </code>
        </th>
        <td>
          <span className={`badge ${model.enabled ? 'text-bg-success' : 'text-bg-secondary'}`}>
            {model.enabled ? t('ai.enabled') : t('ai.disabled')}
          </span>
          <div className="small cb-text-secondary mt-1">{model.capabilities.join(', ')}</div>
        </td>
        <td className="small">
          <div>{t('ai.models.inputPrice', { price: money('PER_1M_INPUT_TOKENS') })}</div>
          <div>{t('ai.models.outputPrice', { price: money('PER_1M_OUTPUT_TOKENS') })}</div>
          {priceOf('PER_1M_CACHED_INPUT_TOKENS') && (
            <div className="cb-text-secondary">
              {t('ai.models.cachedPrice', { price: money('PER_1M_CACHED_INPUT_TOKENS') })}
            </div>
          )}
          {model.currentPricing.length === 0 && (
            <span className="badge text-bg-warning">{t('ai.models.unpriced')}</span>
          )}
          {upcoming.length > 0 && (
            <div className="cb-text-secondary">
              {t('ai.models.upcoming', { count: upcoming.length })}
            </div>
          )}
        </td>
        <td className="small">
          {t('ai.models.paramsSummary', {
            timeout: Math.round(model.params.timeoutMs / 1000),
            retries: model.params.retries,
            concurrency: model.params.concurrency,
            maxOutput: model.params.maxOutputTokens,
          })}
        </td>
        <td className="text-end text-nowrap">
          {canManage && mode === 'view' && (
            <div className="d-flex flex-wrap gap-2 justify-content-end">
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                disabled={runTest.isPending}
                onClick={() => {
                  setTest(null);
                  setError(null);
                  runTest.mutate();
                }}
              >
                {runTest.isPending ? t('ai.models.testing') : t('ai.models.test')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setMode('params')}
              >
                {t('ai.models.editParams')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setMode('price')}
              >
                {t('ai.models.addPrice')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setMode('toggle')}
              >
                {model.enabled ? t('ai.disable') : t('ai.enable')}
              </button>
            </div>
          )}
        </td>
      </tr>
      {(test || (mode === 'view' && error)) && (
        <tr>
          <td colSpan={5}>
            {test && (
              <div
                className={`alert py-2 mb-0 ${test.ok ? 'alert-success' : 'alert-warning'}`}
                role="status"
              >
                {test.ok
                  ? t('ai.models.testOk', {
                      latency: test.latencyMs,
                      model: test.servedModel ?? model.modelId,
                      sample: test.sample,
                    })
                  : t('ai.models.testFailed', { outcome: test.outcome, message: test.message })}
              </div>
            )}
            {mode === 'view' && <ErrorAlert error={error} />}
          </td>
        </tr>
      )}
      {mode !== 'view' && (
        <tr>
          <td colSpan={5}>
            {mode === 'toggle' ? (
              <div className="p-3 cb-surface-muted rounded-2 d-flex flex-wrap gap-2 align-items-center">
                <span>
                  {model.enabled ? t('ai.models.disableExplain') : t('ai.models.enableExplain')}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={save.isPending}
                  onClick={() => save.mutate('')}
                >
                  {model.enabled ? t('ai.disable') : t('ai.enable')}
                </button>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={close}>
                  {t('ai.cancel')}
                </button>
                <ErrorAlert error={error} />
              </div>
            ) : mode === 'params' ? (
              <form
                className="p-3 cb-surface-muted rounded-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate('');
                }}
              >
                <div className="row g-2 mb-2">
                  {PARAM_FIELDS.map((field) => (
                    <div className="col-6 col-md-3" key={field.key}>
                      <label htmlFor={`${id}-${field.key}`} className="form-label small">
                        {t(`ai.models.params.${field.key}`)}
                      </label>
                      <input
                        id={`${id}-${field.key}`}
                        type="number"
                        className="form-control form-control-sm"
                        min={field.min}
                        max={field.max}
                        value={params[field.key]}
                        onChange={(e) =>
                          setParams({ ...params, [field.key]: Number(e.target.value) })
                        }
                      />
                    </div>
                  ))}
                  <div className="col-6 col-md-3">
                    <label htmlFor={`${id}-temperature`} className="form-label small">
                      {t('ai.models.params.temperature')}
                    </label>
                    <input
                      id={`${id}-temperature`}
                      type="number"
                      step="0.1"
                      min={0}
                      max={2}
                      className="form-control form-control-sm"
                      placeholder={t('ai.models.params.temperatureUnset')}
                      value={params.temperature ?? ''}
                      onChange={(e) =>
                        setParams({
                          ...params,
                          temperature: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <p className="small cb-text-secondary">{t('ai.models.params.hint')}</p>
                <ErrorAlert error={error} />
                <div className="d-flex gap-2">
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={save.isPending}
                  >
                    {t('ai.models.saveParams')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={close}
                  >
                    {t('ai.cancel')}
                  </button>
                </div>
              </form>
            ) : (
              <ReasonForm
                submitLabel={t('ai.models.savePrice')}
                pending={save.isPending}
                error={error}
                disabled={!/^\d+(\.\d{1,6})?$/.test(price.amount)}
                onSubmit={(reason) => save.mutate(reason)}
                onCancel={close}
              >
                <div className="row g-2 mb-2">
                  <div className="col-md-4">
                    <label htmlFor={`${id}-unit`} className="form-label small">
                      {t('ai.models.unit')}
                    </label>
                    <select
                      id={`${id}-unit`}
                      className="form-select form-select-sm"
                      value={price.unit}
                      onChange={(e) => setPrice({ ...price, unit: e.target.value as PricingUnit })}
                    >
                      {PricingUnit.options.map((u) => (
                        <option key={u} value={u}>
                          {t(`ai.units.${u}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-md-4">
                    <label htmlFor={`${id}-amount`} className="form-label small">
                      {t('ai.models.amount', { currency: model.pricing[0]?.currency ?? 'USD' })}
                    </label>
                    <input
                      id={`${id}-amount`}
                      className="form-control form-control-sm"
                      inputMode="decimal"
                      placeholder={
                        priceOf(price.unit)
                          ? microsToDecimal(priceOf(price.unit)!.pricePerUnitMicros)
                          : '0.00'
                      }
                      value={price.amount}
                      onChange={(e) => setPrice({ ...price, amount: e.target.value.trim() })}
                    />
                  </div>
                  <div className="col-md-4">
                    <label htmlFor={`${id}-from`} className="form-label small">
                      {t('ai.models.effectiveFrom')}
                    </label>
                    <input
                      id={`${id}-from`}
                      type="datetime-local"
                      className="form-control form-control-sm"
                      value={price.effectiveFrom}
                      onChange={(e) => setPrice({ ...price, effectiveFrom: e.target.value })}
                    />
                  </div>
                </div>
                <p className="small cb-text-secondary">{t('ai.models.priceHint')}</p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AddModel({ providers, onDone }: { providers: AiProviderSummary[]; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const usable = providers.filter((p) => p.available);
  const [form, setForm] = useState({
    providerId: usable[0]?.id ?? '',
    modelId: '',
    displayName: '',
    capabilities: ['LLM'] as AiCapability[],
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => manager.api.post('/admin/ai/models', form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      onDone();
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <form
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="h6">{t('ai.models.addTitle')}</h2>
      <div className="row g-2 mb-2">
        <div className="col-md-3">
          <label htmlFor={`${id}-provider`} className="form-label small">
            {t('ai.providers.provider')}
          </label>
          <select
            id={`${id}-provider`}
            className="form-select form-select-sm"
            value={form.providerId}
            onChange={(e) => setForm({ ...form, providerId: e.target.value })}
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-modelId`} className="form-label small">
            {t('ai.models.modelId')}
          </label>
          <input
            id={`${id}-modelId`}
            className="form-control form-control-sm"
            spellCheck={false}
            value={form.modelId}
            onChange={(e) => setForm({ ...form, modelId: e.target.value.trim() })}
          />
        </div>
        <div className="col-md-5">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('ai.models.displayName')}
          </label>
          <input
            id={`${id}-name`}
            className="form-control form-control-sm"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </div>
      </div>
      <fieldset className="mb-2">
        <legend className="form-label small">{t('ai.models.capabilities')}</legend>
        <div className="d-flex flex-wrap gap-3">
          {AiCapability.options.map((cap) => (
            <div className="form-check" key={cap}>
              <input
                id={`${id}-cap-${cap}`}
                type="checkbox"
                className="form-check-input"
                checked={form.capabilities.includes(cap)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    capabilities: e.target.checked
                      ? [...form.capabilities, cap]
                      : form.capabilities.filter((c) => c !== cap),
                  })
                }
              />
              <label htmlFor={`${id}-cap-${cap}`} className="form-check-label small">
                {cap}
              </label>
            </div>
          ))}
        </div>
      </fieldset>
      <p className="small cb-text-secondary">{t('ai.models.addHint')}</p>
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={
            create.isPending ||
            !form.providerId ||
            form.modelId.length < 2 ||
            form.displayName.trim().length < 2 ||
            form.capabilities.length === 0
          }
        >
          {t('ai.models.create')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onDone}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

export function ModelsPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('ai.manage');
  const [adding, setAdding] = useState(false);
  const models = useQuery({
    queryKey: ['ai', 'models'],
    queryFn: () => manager.api.get<AiModelSummary[]>('/admin/ai/models'),
  });
  const providers = useQuery({
    queryKey: ['ai', 'providers'],
    queryFn: () => manager.api.get<AiProviderSummary[]>('/admin/ai/providers'),
    enabled: canManage,
  });

  return (
    <>
      {canManage && !adding && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => setAdding(true)}
        >
          {t('ai.models.add')}
        </button>
      )}
      {adding && providers.data && (
        <AddModel providers={providers.data} onDone={() => setAdding(false)} />
      )}
      <section className="border cb-border rounded-3 bg-white" aria-label={t('ai.tabs.models')}>
        {models.isPending && <LoadingRow />}
        {models.isError && (
          <div className="m-3">
            <ErrorAlert error={consoleError(t, models.error)} />
          </div>
        )}
        {models.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('ai.models.model')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('ai.models.pricing')}</th>
                  <th scope="col">{t('ai.models.limits')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.data.map((m) => (
                  <ModelRow key={m.id} model={m} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
