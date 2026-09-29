import type {
  ActiveSession,
  AdminMeResponse,
  MfaEnrollment,
  MfaRecoveryCodes,
  MfaStatus,
} from '@cbi/shared-types';
import { deviceName, errorMessage } from '@cbi/web-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { formatDateTime } from '../library/format';
import { EnrollmentDetails, RecoveryCodes } from '../auth/MfaStep';

const mfaKey = ['admin-auth', 'mfa'] as const;
const sessionsKey = ['admin-auth', 'sessions'] as const;

/** A 6-digit authenticator code field with a submit button. */
function CodeForm({
  label,
  submitLabel,
  danger,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  danger?: boolean;
  onSubmit: (code: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t('mfa.codeFormat'));
    setError(null);
    setPending(true);
    try {
      await onSubmit(code);
      setCode('');
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-2">
      <label htmlFor={`${id}-code`} className="form-label small">
        {label}
      </label>
      <div className="d-flex flex-wrap gap-2">
        <input
          id={`${id}-code`}
          className={`form-control font-monospace w-auto ${error ? 'is-invalid' : ''}`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-invalid={error ? true : undefined}
        />
        <button
          type="submit"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={pending}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-outline-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
      </div>
      {error && (
        <div className="invalid-feedback d-block" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/** Two-factor authentication (authenticator app) for the signed-in admin. */
export function MfaSection() {
  const { t, i18n } = useTranslation();
  const { user, manager, setUser } = useAdminAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: mfaKey,
    queryFn: () => manager.api.get<MfaStatus>('/admin/auth/mfa'),
  });
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [action, setAction] = useState<'regenerate' | 'disable' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (enabled: boolean) => {
    await queryClient.invalidateQueries({ queryKey: mfaKey });
    if (user) setUser({ ...(user as AdminMeResponse), mfaEnabled: enabled });
  };

  async function start() {
    setError(null);
    try {
      setEnrollment(await manager.api.post<MfaEnrollment>('/admin/auth/mfa/enroll'));
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const s = status.data;
  return (
    <section
      className="p-4 border cb-border rounded-3 bg-white mt-3"
      style={{ maxWidth: '40rem' }}
      aria-labelledby="mfa-title"
    >
      <h2 id="mfa-title" className="h5">
        {t('mfa.sectionTitle')}
      </h2>
      {status.isPending && <p className="small mb-0">{t('common.loading')}</p>}
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : s && !s.enabled ? (
        <>
          <p className="cb-text-secondary">
            {s.required ? t('mfa.requiredNotOn') : t('mfa.offHint')}
          </p>
          {enrollment ? (
            <>
              <EnrollmentDetails {...enrollment} />
              <CodeForm
                label={t('mfa.codeLabel')}
                submitLabel={t('mfa.turnOn')}
                onCancel={() => setEnrollment(null)}
                onSubmit={async (code) => {
                  const res = await manager.api.post<MfaRecoveryCodes>(
                    '/admin/auth/mfa/enroll/confirm',
                    { code },
                  );
                  setEnrollment(null);
                  setCodes(res.recoveryCodes);
                  await refresh(true);
                }}
              />
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void start()}>
              {t('mfa.setUp')}
            </button>
          )}
        </>
      ) : s ? (
        <>
          <p className="mb-1">
            <i className="bi bi-shield-check me-1" aria-hidden="true" />
            {t('mfa.onSince', { date: formatDateTime(s.enabledAt, i18n.language) })}
          </p>
          <p className="small cb-text-secondary">
            {t('mfa.codesLeft', { count: s.recoveryCodesRemaining })}
            {s.required && ` ${t('mfa.requiredHint')}`}
          </p>
          {action === 'regenerate' ? (
            <CodeForm
              label={t('mfa.confirmWithCode')}
              submitLabel={t('mfa.newCodes')}
              onCancel={() => setAction(null)}
              onSubmit={async (code) => {
                const res = await manager.api.post<MfaRecoveryCodes>(
                  '/admin/auth/mfa/recovery-codes',
                  { code },
                );
                setAction(null);
                setCodes(res.recoveryCodes);
                await refresh(true);
              }}
            />
          ) : action === 'disable' ? (
            <CodeForm
              label={t('mfa.confirmWithCode')}
              submitLabel={t('mfa.turnOff')}
              danger
              onCancel={() => setAction(null)}
              onSubmit={async (code) => {
                await manager.api.post('/admin/auth/mfa/disable', { code });
                setAction(null);
                await refresh(false);
              }}
            />
          ) : (
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-outline-primary"
                onClick={() => setAction('regenerate')}
              >
                {t('mfa.newCodes')}
              </button>
              {!s.required && (
                <button
                  type="button"
                  className="btn btn-outline-danger"
                  onClick={() => setAction('disable')}
                >
                  {t('mfa.turnOff')}
                </button>
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

/** The admin's signed-in devices, each of which can be signed out. */
export function DevicesSection() {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: () => manager.api.get<ActiveSession[]>('/admin/auth/sessions'),
  });
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string) {
    setError(null);
    try {
      await manager.api.delete(`/admin/auth/sessions/${encodeURIComponent(id)}`);
      queryClient.setQueryData<ActiveSession[]>(sessionsKey, (old = []) =>
        old.filter((s) => s.id !== id),
      );
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <section
      className="p-4 border cb-border rounded-3 bg-white mt-3"
      style={{ maxWidth: '40rem' }}
      aria-labelledby="devices-title"
    >
      <h2 id="devices-title" className="h5">
        {t('account.devicesTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('account.devicesHint')}</p>
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {sessions.isPending && <p className="small mb-0">{t('common.loading')}</p>}
      {sessions.data && (
        <ul className="list-group">
          {sessions.data.map((s) => {
            const name = deviceName(s.userAgent) ?? t('account.unknownDevice');
            return (
              <li key={s.id} className="list-group-item d-flex flex-wrap align-items-center gap-2">
                <div className="flex-grow-1">
                  <div className="fw-semibold">
                    {name}
                    {s.current && (
                      <span className="badge text-bg-light border cb-border ms-2">
                        {t('account.thisDevice')}
                      </span>
                    )}
                  </div>
                  <div className="small cb-text-secondary">
                    {t('account.deviceMeta', {
                      signedIn: formatDateTime(s.signedInAt, i18n.language),
                      expires: formatDateTime(s.expiresAt, i18n.language),
                    })}
                  </div>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    aria-label={t('account.signOutDeviceNamed', { name })}
                    onClick={() => void revoke(s.id)}
                  >
                    {t('account.signOutDevice')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
