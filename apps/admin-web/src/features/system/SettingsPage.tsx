import {
  DEFAULT_SETTINGS,
  FinanceSetting,
  KpiTargets,
  MaintenanceSetting,
  UpdateSettingBody,
  type SettingEntry,
  type SettingKey,
} from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatRate, percentInputToRate, rateToPercentInput } from '../analytics/format';
import { formatDateTime, type Issue } from '../library/format';
import { IssueList } from '../library/shared';
import { FieldError } from '../payments/shared';
import { systemKeys, useSettings } from './queries';

type Values = Record<string, string | boolean>;

type Field = {
  name: string;
  kind: 'checkbox' | 'textarea' | 'number' | 'percent';
  /** Where the shared schema reports problems with this field. */
  path: string;
  /** Read-only display of the saved value. */
  show: (value: Record<string, unknown>, locale: string) => string;
  maxLength?: number;
};

type Spec = {
  key: SettingKey;
  schema: z.ZodType;
  fields: Field[];
  toForm: (value: Record<string, unknown>) => Values;
  toValue: (values: Values) => unknown;
};

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : '');
const numberInput = (value: string) =>
  /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
const percentField = (name: string): Field => ({
  name,
  kind: 'percent',
  path: name,
  show: (v, locale) => formatRate(Number(v[name]), locale, 2),
});

const SPECS: Spec[] = [
  {
    key: 'maintenance',
    schema: MaintenanceSetting,
    fields: [
      {
        name: 'enabled',
        kind: 'checkbox',
        path: 'enabled',
        show: (v) => (v.enabled ? 'on' : 'off'),
      },
      {
        name: 'message',
        kind: 'textarea',
        path: 'message',
        maxLength: 300,
        show: (v) => String(v.message ?? '') || '—',
      },
    ],
    toForm: (v) => ({ enabled: Boolean(v.enabled), message: String(v.message ?? '') }),
    toValue: (values) => ({ enabled: values.enabled === true, message: str(values.message) }),
  },
  {
    key: 'finance',
    schema: FinanceSetting,
    fields: [
      {
        name: 'usdToInr',
        kind: 'number',
        path: 'usdToInr',
        show: (v, locale) =>
          `₹${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(v.usdToInr))}`,
      },
      percentField('gatewayFeeRate'),
    ],
    toForm: (v) => ({
      usdToInr: String(v.usdToInr ?? ''),
      gatewayFeeRate: rateToPercentInput(Number(v.gatewayFeeRate ?? 0)),
    }),
    toValue: (values) => ({
      usdToInr: numberInput(str(values.usdToInr)),
      gatewayFeeRate: percentInputToRate(str(values.gatewayFeeRate)),
    }),
  },
  {
    key: 'targets',
    schema: KpiTargets,
    fields: ['completionRate', 'freeToPaidRate', 'grossMargin', 'maxFailureRate'].map(percentField),
    toForm: (v) =>
      Object.fromEntries(
        ['completionRate', 'freeToPaidRate', 'grossMargin', 'maxFailureRate'].map((k) => [
          k,
          rateToPercentInput(Number(v[k] ?? 0)),
        ]),
      ),
    toValue: (values) =>
      Object.fromEntries(
        ['completionRate', 'freeToPaidRate', 'grossMargin', 'maxFailureRate'].map((k) => [
          k,
          percentInputToRate(str(values[k])),
        ]),
      ),
  },
];

/** Problems from a VALIDATION_FAILED reply: `details` is the issue list or `{ issues }`. */
function serverIssues(err: unknown): Issue[] {
  if (!(err instanceof ApiClientError) || err.code !== 'VALIDATION_FAILED') return [];
  const details = err.details as unknown;
  const list = Array.isArray(details)
    ? details
    : (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const i = raw as { path?: unknown; message?: unknown };
    if (typeof i?.message !== 'string') return [];
    const path = Array.isArray(i.path)
      ? i.path.join('.')
      : typeof i.path === 'string'
        ? i.path
        : '';
    return [{ path, message: i.message }];
  });
}

function currentValue(spec: Spec, entry: SettingEntry | undefined): Record<string, unknown> {
  const parsed = spec.schema.safeParse(entry?.value);
  return (parsed.success ? parsed.data : DEFAULT_SETTINGS[spec.key]) as Record<string, unknown>;
}

function SettingSection({ spec, entry }: { spec: Spec; entry: SettingEntry | undefined }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canManage = useCan('system.manage');
  const value = currentValue(spec, entry);
  const [values, setValues] = useState<Values>(() => spec.toForm(value));
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Set<string>>(new Set());
  const [reasonError, setReasonError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `system.settings.${spec.key}`;

  const save = useMutation({
    mutationFn: (body: { value: unknown; reason: string }) =>
      manager.api.put<SettingEntry>(`/admin/settings/${spec.key}`, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData<SettingEntry[]>(systemKeys.settings, (list) =>
        list?.map((e) => (e.key === saved.key ? saved : e)),
      );
      await queryClient.invalidateQueries({ queryKey: systemKeys.settings });
      setReason('');
      setNotice(t('system.settings.saved', { name: t(`${base}.title`) }));
    },
    onError: (err) => {
      const found = serverIssues(err);
      setIssues(found);
      setError(consoleError(t, err));
    },
  });

  const submit = () => {
    setNotice(null);
    setError(null);
    setIssues([]);
    const next = spec.toValue(values);
    const parsed = spec.schema.safeParse(next);
    const bad = new Set<string>();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = spec.fields.find((f) => f.path === issue.path.join('.'));
        if (field) bad.add(field.name);
      }
    }
    const reasonOk = UpdateSettingBody.shape.reason.safeParse(reason).success;
    setFieldErrors(bad);
    setReasonError(!reasonOk);
    if (!parsed.success || !reasonOk) return;
    save.mutate({ value: parsed.data, reason: reason.trim() });
  };

  const fieldId = (name: string) => `${id}-${name}`;
  const errorId = (name: string) => `${id}-${name}-error`;
  const hintId = (name: string) => `${id}-${name}-hint`;
  const hasHint = (name: string) => i18n.exists(`${base}.hints.${name}`);

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h5">
        {t(`${base}.title`)}
      </h2>
      <p className="small cb-text-secondary">{t(`${base}.explain`)}</p>
      {spec.key === 'maintenance' && (
        <div className="alert alert-warning py-2 small">
          <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
          {t('system.settings.maintenance.warning')}
        </div>
      )}
      <p className="small cb-text-secondary">
        {entry?.updatedAt
          ? t('system.settings.lastUpdated', {
              time: formatDateTime(entry.updatedAt, i18n.language),
            })
          : t('system.settings.defaultValue')}
        {entry?.updatedBy && ` ${t('system.updatedBy', { by: entry.updatedBy })}`}
      </p>

      {!canManage ? (
        <dl className="row small mb-0">
          {spec.fields.map((f) => (
            <Fragment key={f.name}>
              <dt className="col-sm-5">{t(`${base}.fields.${f.name}`)}</dt>
              <dd className="col-sm-7">
                {f.kind === 'checkbox'
                  ? t(`system.settings.${value[f.name] ? 'on' : 'off'}`)
                  : f.show(value, i18n.language)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="row g-2 mb-2">
            {spec.fields.map((f) => {
              const invalid = fieldErrors.has(f.name);
              const describedBy =
                [invalid ? errorId(f.name) : '', hasHint(f.name) ? hintId(f.name) : '']
                  .join(' ')
                  .trim() || undefined;
              const label = t(`${base}.fields.${f.name}`);
              if (f.kind === 'checkbox') {
                return (
                  <div className="col-12" key={f.name}>
                    <div className="form-check form-switch">
                      <input
                        id={fieldId(f.name)}
                        type="checkbox"
                        role="switch"
                        className="form-check-input"
                        checked={values[f.name] === true}
                        onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
                        aria-describedby={describedBy}
                      />
                      <label htmlFor={fieldId(f.name)} className="form-check-label">
                        {label}
                      </label>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  className={f.kind === 'textarea' ? 'col-12' : 'col-sm-6 col-lg-3'}
                  key={f.name}
                >
                  <label htmlFor={fieldId(f.name)} className="form-label small">
                    {label}
                  </label>
                  {f.kind === 'textarea' ? (
                    <textarea
                      id={fieldId(f.name)}
                      className={`form-control form-control-sm ${invalid ? 'is-invalid' : ''}`}
                      rows={2}
                      maxLength={f.maxLength}
                      value={str(values[f.name])}
                      onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                    />
                  ) : (
                    <div className="input-group input-group-sm">
                      {f.kind === 'number' && <span className="input-group-text">₹</span>}
                      <input
                        id={fieldId(f.name)}
                        type="text"
                        inputMode="decimal"
                        className={`form-control ${invalid ? 'is-invalid' : ''}`}
                        value={str(values[f.name])}
                        onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                      />
                      {f.kind === 'percent' && <span className="input-group-text">%</span>}
                    </div>
                  )}
                  <FieldError
                    id={errorId(f.name)}
                    message={invalid ? t(`${base}.errors.${f.name}`) : undefined}
                  />
                  {hasHint(f.name) && (
                    <div id={hintId(f.name)} className="form-text">
                      {t(`${base}.hints.${f.name}`)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <label htmlFor={`${id}-reason`} className="form-label small">
            {t('ai.reason')}
          </label>
          <input
            id={`${id}-reason`}
            className={`form-control form-control-sm mb-1 ${reasonError ? 'is-invalid' : ''}`}
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={reasonError || undefined}
            aria-describedby={reasonError ? `${id}-reason-error` : undefined}
          />
          <FieldError
            id={`${id}-reason-error`}
            message={reasonError ? t('system.settings.reasonError') : undefined}
          />
          <div className="mt-2">
            <IssueList issues={issues} />
            <ErrorAlert error={issues.length > 0 ? null : error} />
            <div role="status" aria-live="polite">
              {notice && <div className="alert alert-success py-2">{notice}</div>}
            </div>
            <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending}>
              {t(`${base}.save`)}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const canManage = useCan('system.manage');
  const settings = useSettings();
  return (
    <>
      <h1 className="h3 mb-2">{t('system.settings.title')}</h1>
      <p className="cb-text-secondary">{t('system.settings.subtitle')}</p>
      {!canManage && (
        <p className="small cb-text-secondary">
          <i className="bi bi-lock me-1" aria-hidden="true" />
          {t('system.readOnly')}
        </p>
      )}
      {settings.isPending && <LoadingRow />}
      <ErrorAlert error={settings.isError ? consoleError(t, settings.error) : null} />
      {settings.data &&
        SPECS.map((spec) => (
          <SettingSection
            key={spec.key}
            spec={spec}
            entry={settings.data.find((e) => e.key === spec.key)}
          />
        ))}
    </>
  );
}
