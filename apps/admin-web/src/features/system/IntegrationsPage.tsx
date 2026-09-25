import {
  INTEGRATION_REQUIREMENTS,
  IntegrationKind,
  IntegrationSpecs,
  TestIntegrationBody,
  UpdateIntegrationBody,
  type IntegrationSummary,
  type IntegrationTestResult,
} from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { config } from '../../config';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime, type Issue } from '../library/format';
import { IssueList } from '../library/shared';
import { FieldError } from '../payments/shared';
import { serverIssues } from './format';
import { systemKeys, useIntegrations } from './queries';

type Kind = IntegrationKind;

type SettingField = {
  name: string;
  type: 'text' | 'number' | 'checkbox';
  /** Providers this field applies to. */
  providers: string[];
  placeholder?: string;
};

type SecretField = { name: string; providers: string[] };

/** The form for each kind: which settings and secrets each provider uses. */
const FIELDS: Record<Kind, { settings: SettingField[]; secrets: SecretField[] }> = {
  email: {
    settings: [
      { name: 'from', type: 'text', providers: ['ses', 'smtp'] },
      { name: 'sesRegion', type: 'text', providers: ['ses'], placeholder: 'ap-south-1' },
      { name: 'smtpHost', type: 'text', providers: ['smtp'] },
      { name: 'smtpPort', type: 'number', providers: ['smtp'], placeholder: '587' },
      { name: 'smtpSecure', type: 'checkbox', providers: ['smtp'] },
      { name: 'smtpUser', type: 'text', providers: ['smtp'] },
    ],
    secrets: [
      { name: 'sesAccessKeyId', providers: ['ses'] },
      { name: 'sesSecretAccessKey', providers: ['ses'] },
      { name: 'smtpPass', providers: ['smtp'] },
    ],
  },
  payments: {
    settings: [{ name: 'keyId', type: 'text', providers: ['razorpay'], placeholder: 'rzp_live_…' }],
    secrets: [
      { name: 'keySecret', providers: ['razorpay'] },
      { name: 'webhookSecret', providers: ['razorpay'] },
    ],
  },
  storage: {
    settings: [
      { name: 'zone', type: 'text', providers: ['bunny'] },
      {
        name: 'regionHost',
        type: 'text',
        providers: ['bunny'],
        placeholder: 'storage.bunnycdn.com',
      },
    ],
    secrets: [{ name: 'accessKey', providers: ['bunny'] }],
  },
  sms: {
    settings: [
      { name: 'templateId', type: 'text', providers: ['msg91'] },
      { name: 'otpVariable', type: 'text', providers: ['msg91'], placeholder: 'otp' },
    ],
    secrets: [{ name: 'authKey', providers: ['msg91'] }],
  },
  judge: {
    settings: [
      {
        name: 'baseUrl',
        type: 'text',
        providers: ['codebegun', 'judge0'],
        placeholder: 'https://',
      },
    ],
    secrets: [
      { name: 'hmacSecret', providers: ['codebegun', 'judge0'] },
      { name: 'judge0AuthToken', providers: ['judge0'] },
    ],
  },
};

/** Razorpay events the payments webhook handles. */
const RAZORPAY_WEBHOOK_EVENTS = [
  'payment.captured',
  'order.paid',
  'payment.failed',
  'refund.processed',
  'refund.failed',
];

const razorpayWebhookUrl = () =>
  `${config.apiUrl.replace(/\/+$/, '')}/api/v1/payments/webhooks/razorpay`;

/** The shared judge contract requires a signing secret of at least this length. */
const HMAC_MIN_LENGTH = 32;
const HOST_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

const kindName = (t: TFunction, kind: Kind) => t(`system.integrations.kinds.${kind}.title`);
const fieldLabel = (t: TFunction, kind: Kind, name: string) =>
  t(`system.integrations.kinds.${kind}.fields.${name}`, { defaultValue: name });
const providerLabel = (t: TFunction, provider: string) =>
  t(`system.integrations.providerNames.${provider}`, { defaultValue: provider });

function secretState(t: TFunction, state: { set: boolean; last4: string | null } | undefined) {
  if (!state?.set) return t('system.integrations.notSet');
  return state.last4
    ? t('system.integrations.secretSaved', { last4: state.last4 })
    : t('system.integrations.secretSavedNoHint');
}

function StatusBadge({ summary }: { summary: IntegrationSummary }) {
  const { t } = useTranslation();
  if (summary.provider === 'disabled') {
    return <span className="badge text-bg-secondary">{t('system.integrations.status.off')}</span>;
  }
  if (summary.ready) {
    return <span className="badge text-bg-success">{t('system.integrations.status.ready')}</span>;
  }
  return (
    <span className="badge text-bg-warning text-wrap text-start">
      {summary.missing.length > 0
        ? t('system.integrations.status.notReadyMissing', {
            missing: summary.missing.map((m) => fieldLabel(t, summary.kind, m)).join(', '),
          })
        : t('system.integrations.status.notReady')}
    </span>
  );
}

type Values = Record<string, string | boolean>;

function toForm(kind: Kind, settings: Record<string, unknown>): Values {
  return Object.fromEntries(
    FIELDS[kind].settings.map((f) => {
      const v = settings[f.name];
      if (f.type === 'checkbox') return [f.name, v === true];
      return [f.name, v === undefined || v === null ? '' : String(v)];
    }),
  );
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v.trim() : '');

function IntegrationEditor({
  summary,
  onDone,
}: {
  summary: IntegrationSummary;
  onDone: (saved: IntegrationSummary | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const kind = summary.kind;
  const name = kindName(t, kind);
  const [provider, setProvider] = useState(summary.provider);
  const [values, setValues] = useState<Values>(() => toForm(kind, summary.settings));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reasonError, setReasonError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);

  const fields = FIELDS[kind].settings.filter((f) => f.providers.includes(provider));
  // Turned off: saved credentials stay listed so they can be cleared.
  const secretFields = FIELDS[kind].secrets.filter((f) =>
    provider === 'disabled' ? summary.secrets[f.name]?.set : f.providers.includes(provider),
  );
  const base = `system.integrations.kinds.${kind}`;
  const hint = (field: string) =>
    i18n.exists(`${base}.hints.${field}`) ? t(`${base}.hints.${field}`) : null;

  const save = useMutation({
    mutationFn: (body: UpdateIntegrationBody) =>
      manager.api.put<IntegrationSummary>(`/admin/integrations/${kind}`, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData<IntegrationSummary[]>(systemKeys.integrations, (list) =>
        list?.map((s) => (s.kind === saved.kind ? saved : s)),
      );
      await queryClient.invalidateQueries({ queryKey: systemKeys.integrations });
      onDone(saved);
    },
    onError: (err) => {
      setIssues(serverIssues(err));
      setError(consoleError(t, err));
    },
  });

  const submit = () => {
    setError(null);
    setIssues([]);
    const providerName = providerLabel(t, provider);
    const required = INTEGRATION_REQUIREMENTS[kind][provider] ?? { settings: [], secrets: [] };
    const found: Record<string, string> = {};

    const settings: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (f.type === 'checkbox') {
        settings[f.name] = v === true;
        continue;
      }
      const text = str(v);
      if (!text) {
        if (required.settings.includes(f.name)) {
          found[f.name] = t('system.integrations.errors.required', { provider: providerName });
        }
        continue;
      }
      if (f.type === 'number') {
        const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
        if (!(n >= 1 && n <= 65535)) found[f.name] = t('system.integrations.errors.port');
        settings[f.name] = n;
      } else {
        if (f.name === 'baseUrl' && !URL_PATTERN.test(text)) {
          found[f.name] = t('system.integrations.errors.url');
        }
        if (f.name === 'regionHost' && !HOST_PATTERN.test(text)) {
          found[f.name] = t('system.integrations.errors.host');
        }
        settings[f.name] = text;
      }
    }
    // Anything else the shared schema rejects (lengths and the like), with its own message.
    const parsed = IntegrationSpecs[kind].settings.safeParse(settings);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (field && !found[field]) found[field] = issue.message;
      }
    }

    const secretBody: Record<string, string | null> = {};
    for (const f of secretFields) {
      const typed = (secrets[f.name] ?? '').trim();
      const isCleared = cleared.has(f.name);
      if (isCleared) secretBody[f.name] = null;
      else if (typed) secretBody[f.name] = typed;
      if (required.secrets.includes(f.name)) {
        if (isCleared) {
          found[f.name] = t('system.integrations.errors.secretCleared', { provider: providerName });
        } else if (!typed && !summary.secrets[f.name]?.set) {
          found[f.name] = t('system.integrations.errors.secretRequired', {
            provider: providerName,
          });
        }
      }
      if (f.name === 'hmacSecret' && typed && typed.length < HMAC_MIN_LENGTH) {
        found[f.name] = t('system.integrations.errors.hmacLength');
      }
    }

    const reasonOk = UpdateIntegrationBody.shape.reason.safeParse(reason).success;
    setErrors(found);
    setReasonError(!reasonOk);
    if (Object.keys(found).length > 0 || !reasonOk) return;
    save.mutate({ provider, settings, secrets: secretBody, reason: reason.trim() });
  };

  const fieldId = (field: string) => `${id}-${field}`;
  const errorId = (field: string) => `${id}-${field}-error`;
  const hintId = (field: string) => `${id}-${field}-hint`;
  const describedBy = (field: string, extraHint = false) =>
    [errors[field] ? errorId(field) : '', hint(field) || extraHint ? hintId(field) : '']
      .join(' ')
      .trim() || undefined;

  return (
    <form
      noValidate
      className="p-3 cb-surface-muted rounded-2 mt-3"
      aria-label={t('system.integrations.editTitle', { name })}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="fw-semibold mb-2">{t('system.integrations.editTitle', { name })}</p>
      <div className="mb-3" style={{ maxWidth: '20rem' }}>
        <label htmlFor={fieldId('provider')} className="form-label small">
          {t('system.integrations.provider')}
        </label>
        <select
          id={fieldId('provider')}
          className="form-select form-select-sm"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setErrors({});
          }}
        >
          {summary.providers.map((p) => (
            <option key={p} value={p}>
              {providerLabel(t, p)}
            </option>
          ))}
        </select>
      </div>

      {kind === 'storage' && provider !== 'disabled' && (
        <div className="alert alert-warning py-2 small">
          <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
          {t('system.integrations.kinds.storage.warning')}
        </div>
      )}

      {fields.length > 0 && (
        <div className="row g-2 mb-2">
          {fields.map((f) => {
            const label = fieldLabel(t, kind, f.name);
            const invalid = Boolean(errors[f.name]);
            if (f.type === 'checkbox') {
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
                    />
                    <label htmlFor={fieldId(f.name)} className="form-check-label small">
                      {label}
                    </label>
                  </div>
                </div>
              );
            }
            return (
              <div className="col-md-6" key={f.name}>
                <label htmlFor={fieldId(f.name)} className="form-label small">
                  {label}
                </label>
                <input
                  id={fieldId(f.name)}
                  type="text"
                  inputMode={f.type === 'number' ? 'numeric' : undefined}
                  className={`form-control form-control-sm ${invalid ? 'is-invalid' : ''}`}
                  value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                  placeholder={f.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy(f.name)}
                />
                <FieldError id={errorId(f.name)} message={errors[f.name]} />
                {hint(f.name) && (
                  <div id={hintId(f.name)} className="form-text">
                    {hint(f.name)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {secretFields.length > 0 && (
        <div className="row g-2 mb-2">
          {secretFields.map((f) => {
            const label = fieldLabel(t, kind, f.name);
            const invalid = Boolean(errors[f.name]);
            const state = summary.secrets[f.name];
            const isCleared = cleared.has(f.name);
            return (
              <div className="col-md-6" key={f.name}>
                <label htmlFor={fieldId(f.name)} className="form-label small">
                  {label}
                </label>
                <div className="input-group input-group-sm">
                  <input
                    id={fieldId(f.name)}
                    type="password"
                    className={`form-control ${invalid ? 'is-invalid' : ''}`}
                    autoComplete="new-password"
                    spellCheck={false}
                    value={isCleared ? '' : (secrets[f.name] ?? '')}
                    disabled={isCleared}
                    placeholder={
                      isCleared ? t('system.integrations.willClear') : secretState(t, state)
                    }
                    onChange={(e) => setSecrets({ ...secrets, [f.name]: e.target.value })}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy(f.name, true)}
                  />
                  {state?.set && (
                    <button
                      type="button"
                      className={`btn ${isCleared ? 'btn-outline-secondary' : 'btn-outline-danger'}`}
                      aria-label={
                        isCleared
                          ? t('system.integrations.undoClearField', { field: label })
                          : t('system.integrations.clearField', { field: label })
                      }
                      onClick={() => {
                        const next = new Set(cleared);
                        if (isCleared) next.delete(f.name);
                        else next.add(f.name);
                        setCleared(next);
                        setSecrets({ ...secrets, [f.name]: '' });
                      }}
                    >
                      {isCleared
                        ? t('system.integrations.undoClear')
                        : t('system.integrations.clear')}
                    </button>
                  )}
                </div>
                <FieldError id={errorId(f.name)} message={errors[f.name]} />
                <div id={hintId(f.name)} className="form-text">
                  {hint(f.name) && <span className="d-block">{hint(f.name)}</span>}
                  {state?.set && !isCleared && t('system.integrations.secretTyped')}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
        message={reasonError ? t('system.integrations.errors.reason') : undefined}
      />
      <div className="mt-2">
        <IssueList issues={issues} />
        <ErrorAlert error={issues.length > 0 ? null : error} />
        <div className="d-flex gap-2">
          <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending}>
            {t('system.integrations.save', { name })}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => onDone(null)}
          >
            {t('system.integrations.cancel')}
          </button>
        </div>
      </div>
    </form>
  );
}

function TestPanel({
  summary,
  onResult,
  onCancel,
}: {
  summary: IntegrationSummary;
  onResult: (result: IntegrationTestResult) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [to, setTo] = useState('');
  const [toError, setToError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: (body: { to?: string }) =>
      manager.api.post<IntegrationTestResult>(`/admin/integrations/${summary.kind}/test`, body),
    onSuccess: async (result) => {
      onResult(result);
      await queryClient.invalidateQueries({ queryKey: systemKeys.integrations });
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <form
      noValidate
      className="p-3 cb-surface-muted rounded-2 mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const value = to.trim();
        const valid = value !== '' && TestIntegrationBody.safeParse({ to: value }).success;
        setToError(!valid);
        if (valid) test.mutate({ to: value });
      }}
    >
      <label htmlFor={`${id}-to`} className="form-label small">
        {t('system.integrations.testTo')}
      </label>
      <input
        id={`${id}-to`}
        type="email"
        className={`form-control form-control-sm mb-1 ${toError ? 'is-invalid' : ''}`}
        style={{ maxWidth: '24rem' }}
        autoComplete="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        aria-invalid={toError || undefined}
        aria-describedby={`${id}-to-hint`}
      />
      <div id={`${id}-to-hint`} className={toError ? 'invalid-feedback d-block' : 'form-text'}>
        {toError ? t('system.integrations.testToError') : t('system.integrations.testToHint')}
      </div>
      <ErrorAlert error={error} />
      <div className="d-flex gap-2 mt-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={test.isPending}>
          {test.isPending ? t('system.integrations.testing') : t('system.integrations.runTest')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          {t('system.integrations.cancel')}
        </button>
      </div>
    </form>
  );
}

function ResetPanel({
  summary,
  onDone,
}: {
  summary: IntegrationSummary;
  onDone: (saved: IntegrationSummary | null) => void;
}) {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const name = kindName(t, summary.kind);

  const reset = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<IntegrationSummary>(`/admin/integrations/${summary.kind}/reset`, {
        reason,
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData<IntegrationSummary[]>(systemKeys.integrations, (list) =>
        list?.map((s) => (s.kind === saved.kind ? saved : s)),
      );
      await queryClient.invalidateQueries({ queryKey: systemKeys.integrations });
      onDone(saved);
    },
    onError: async (err) => {
      setError(consoleError(t, err));
      // A 404 means there was nothing saved here any more: show the current state.
      await queryClient.invalidateQueries({ queryKey: systemKeys.integrations });
    },
  });

  return (
    <div className="mt-3">
      <ReasonForm
        submitLabel={t('system.integrations.confirmReset')}
        danger
        pending={reset.isPending}
        error={error}
        onSubmit={(reason) => reset.mutate(reason)}
        onCancel={() => onDone(null)}
      >
        <p>{t('system.integrations.resetExplain', { name })}</p>
      </ReasonForm>
    </div>
  );
}

function IntegrationCard({ summary }: { summary: IntegrationSummary }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const canManage = useCan('system.manage');
  const [mode, setMode] = useState<'view' | 'edit' | 'test' | 'reset'>('view');
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = summary.kind;
  const name = kindName(t, kind);
  const base = `system.integrations.kinds.${kind}`;

  // Kinds other than email test straight away (nothing to ask first).
  const directTest = useMutation({
    mutationFn: () =>
      manager.api.post<IntegrationTestResult>(`/admin/integrations/${kind}/test`, {}),
    onSuccess: async (res) => {
      setResult(res);
      await queryClient.invalidateQueries({ queryKey: systemKeys.integrations });
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  const start = (next: typeof mode) => {
    setNotice(null);
    setResult(null);
    setError(null);
    setMode(next);
  };

  const shownSettings = FIELDS[kind].settings.filter(
    (f) => f.providers.includes(summary.provider) && summary.settings[f.name] !== undefined,
  );
  const shownSecrets = FIELDS[kind].secrets.filter((f) => f.providers.includes(summary.provider));

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2">
        <div>
          <h2 id={`${id}-heading`} className="h5 mb-1">
            {name}
          </h2>
          <p className="small cb-text-secondary mb-2">{t(`${base}.explain`)}</p>
        </div>
        <StatusBadge summary={summary} />
      </div>

      {kind === 'judge' && (
        <p className="small mb-2">
          <i className="bi bi-info-circle me-1" aria-hidden="true" />
          {t('system.integrations.kinds.judge.note')}
        </p>
      )}

      <dl className="row small mb-2">
        <dt className="col-sm-4">{t('system.integrations.source.label')}</dt>
        <dd className="col-sm-8">{t(`system.integrations.source.${summary.source}`)}</dd>
        <dt className="col-sm-4">{t('system.integrations.provider')}</dt>
        <dd className="col-sm-8">{providerLabel(t, summary.provider)}</dd>
        <dt className="col-sm-4">{t('system.integrations.lastTest')}</dt>
        <dd className="col-sm-8">
          {summary.lastTest ? (
            <>
              <span
                className={`badge ${summary.lastTest.ok ? 'text-bg-success' : 'text-bg-danger'} me-1`}
              >
                {summary.lastTest.ok
                  ? t('system.integrations.testPassed')
                  : t('system.integrations.testFailed')}
              </span>
              {t('system.integrations.testAt', {
                time: formatDateTime(summary.lastTest.at, i18n.language),
              })}
              <span className="d-block cb-text-secondary">{summary.lastTest.message}</span>
            </>
          ) : (
            t('system.integrations.neverTested')
          )}
        </dd>
        <dt className="col-sm-4">{t('system.integrations.updated')}</dt>
        <dd className="col-sm-8">
          {summary.updatedAt
            ? formatDateTime(summary.updatedAt, i18n.language)
            : t('system.integrations.neverUpdated')}
          {summary.updatedBy && ` ${t('system.updatedBy', { by: summary.updatedBy })}`}
        </dd>
      </dl>

      {summary.source === 'admin' && (shownSettings.length > 0 || shownSecrets.length > 0) && (
        <>
          <h3 className="h6 small fw-semibold mb-1">{t('system.integrations.currentValues')}</h3>
          <dl className="row small mb-2">
            {shownSettings.map((f) => (
              <Fragment key={f.name}>
                <dt className="col-sm-4">{fieldLabel(t, kind, f.name)}</dt>
                <dd className="col-sm-8 text-break">
                  {f.type === 'checkbox'
                    ? t(`system.integrations.${summary.settings[f.name] ? 'on' : 'off'}`)
                    : String(summary.settings[f.name])}
                </dd>
              </Fragment>
            ))}
            {shownSecrets.map((f) => (
              <Fragment key={f.name}>
                <dt className="col-sm-4">{fieldLabel(t, kind, f.name)}</dt>
                <dd className="col-sm-8">{secretState(t, summary.secrets[f.name])}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
      {summary.source === 'env' && (
        <p className="small cb-text-secondary">{t('system.integrations.serverFileValues')}</p>
      )}

      {kind === 'payments' && (
        <div className="p-2 border cb-border rounded-2 small mb-2">
          <div className="fw-semibold">{t('system.integrations.kinds.payments.webhookTitle')}</div>
          <div>
            {t('system.integrations.kinds.payments.webhookUrl')}:{' '}
            <code className="text-break">{razorpayWebhookUrl()}</code>
          </div>
          <div>
            {t('system.integrations.kinds.payments.webhookEvents')}:{' '}
            {RAZORPAY_WEBHOOK_EVENTS.map((e, i) => (
              <Fragment key={e}>
                {i > 0 && ', '}
                <code>{e}</code>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2 mb-2">{notice}</div>}
        {result && (
          <div className={`alert ${result.ok ? 'alert-success' : 'alert-danger'} py-2 mb-2`}>
            {result.ok
              ? t('system.integrations.testOk', { message: result.message })
              : t('system.integrations.testNotOk', { message: result.message })}
          </div>
        )}
      </div>
      <ErrorAlert error={error} />

      {canManage && mode === 'view' && (
        <div className="d-flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            aria-label={t('system.integrations.editKind', { name })}
            onClick={() => start('edit')}
          >
            {t('system.integrations.edit')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            aria-label={t('system.integrations.testKind', { name })}
            disabled={directTest.isPending}
            onClick={() => {
              if (kind === 'email') {
                start('test');
              } else {
                start('view');
                directTest.mutate();
              }
            }}
          >
            {directTest.isPending
              ? t('system.integrations.testing')
              : t('system.integrations.test')}
          </button>
          {summary.source === 'admin' && (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              aria-label={t('system.integrations.resetKind', { name })}
              onClick={() => start('reset')}
            >
              {t('system.integrations.reset')}
            </button>
          )}
        </div>
      )}

      {canManage && mode === 'edit' && (
        <IntegrationEditor
          summary={summary}
          onDone={(saved) => {
            setMode('view');
            if (saved) setNotice(t('system.integrations.saved', { name }));
          }}
        />
      )}
      {canManage && mode === 'test' && (
        <TestPanel
          summary={summary}
          onResult={(res) => {
            setMode('view');
            setResult(res);
          }}
          onCancel={() => setMode('view')}
        />
      )}
      {canManage && mode === 'reset' && (
        <ResetPanel
          summary={summary}
          onDone={(saved) => {
            setMode('view');
            if (saved) setNotice(t('system.integrations.resetDone', { name }));
          }}
        />
      )}
    </section>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const canManage = useCan('system.manage');
  const integrations = useIntegrations();
  const ordered = integrations.data
    ? IntegrationKind.options.flatMap((k) => integrations.data.filter((s) => s.kind === k))
    : [];

  return (
    <>
      <h1 className="h3 mb-2">{t('system.integrations.title')}</h1>
      <p className="cb-text-secondary">{t('system.integrations.subtitle')}</p>
      <div className="alert alert-info small" role="note">
        <div className="fw-semibold mb-1">
          <i className="bi bi-shield-lock me-1" aria-hidden="true" />
          {t('system.integrations.explainTitle')}
        </div>
        <ul className="mb-0 ps-3">
          <li>{t('system.integrations.explain.encrypted')}</li>
          <li>{t('system.integrations.explain.immediate')}</li>
          <li>{t('system.integrations.explain.override')}</li>
        </ul>
      </div>
      {!canManage && (
        <p className="small cb-text-secondary">
          <i className="bi bi-lock me-1" aria-hidden="true" />
          {t('system.readOnly')}
        </p>
      )}
      {integrations.isPending && <LoadingRow />}
      <ErrorAlert error={integrations.isError ? consoleError(t, integrations.error) : null} />
      {ordered.map((summary) => (
        <IntegrationCard key={summary.kind} summary={summary} />
      ))}
    </>
  );
}
