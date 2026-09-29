import { TOTP_DIGITS, type MfaChallenge, type MfaSessionResponse } from '@cbi/shared-types';
import { errorMessage, type ApiClient } from '@cbi/web-core';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode } from './QrCode';

/** Copies text, reporting whether it worked (clipboard access can be refused). */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A QR code of the otpauth:// URI to scan, with the setup key (copyable) and
 * the URI itself as fallbacks for apps or devices that cannot scan.
 */
export function EnrollmentDetails({ secret, otpauthUri }: { secret: string; otpauthUri: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Groups of four are easier to type into an app by hand.
  const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
  return (
    <div className="mb-3">
      <ol className="small ps-3">
        <li>{t('mfa.enrollStep1')}</li>
        <li>{t('mfa.enrollStep2')}</li>
        <li>{t('mfa.enrollStep3')}</li>
      </ol>
      <div className="mb-2">
        <QrCode text={otpauthUri} label={t('mfa.qrLabel')} />
      </div>
      <div className="p-3 border cb-border rounded-3 cb-surface-muted">
        <p className="small mb-2">{t('mfa.cannotScan')}</p>
        <div className="small cb-text-secondary">{t('mfa.secretLabel')}</div>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <code className="fs-6 text-break" data-testid="mfa-secret">
            {grouped}
          </code>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={async () => setCopied(await copy(secret))}
          >
            <i className="bi bi-clipboard me-1" aria-hidden="true" />
            {t('mfa.copySecret')}
          </button>
          {copied && (
            <span className="small" role="status">
              {t('mfa.copied')}
            </span>
          )}
        </div>
        <details className="mt-2 small">
          <summary>{t('mfa.showUri')}</summary>
          <code className="d-block text-break mt-1">{otpauthUri}</code>
        </details>
      </div>
    </div>
  );
}

/** Shown once after set-up: each code signs in once when the phone is not at hand. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <h2 className="h5">{t('mfa.recoveryTitle')}</h2>
      <p className="small">{t('mfa.recoveryHint')}</p>
      <ul
        className="list-unstyled row row-cols-2 g-1 font-monospace mb-3"
        aria-label={t('mfa.recoveryTitle')}
      >
        {codes.map((code) => (
          <li key={code} className="col">
            {code}
          </li>
        ))}
      </ul>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-outline-secondary"
          onClick={async () => setCopied(await copy(codes.join('\n')))}
        >
          <i className="bi bi-clipboard me-1" aria-hidden="true" />
          {copied ? t('mfa.copied') : t('mfa.copyCodes')}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          {t('mfa.savedCodes')}
        </button>
      </div>
    </div>
  );
}

/**
 * Second sign-in step: an authenticator code (or a recovery code), or first
 * setting up the authenticator when 2FA is required and not yet on.
 */
export function MfaStep({
  api,
  challenge,
  onSignedIn,
  onRestart,
}: {
  api: ApiClient;
  challenge: MfaChallenge;
  onSignedIn: (session: MfaSessionResponse) => Promise<void>;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [codes, setCodes] = useState<{ session: MfaSessionResponse; codes: string[] } | null>(null);

  if (codes) {
    return <RecoveryCodes codes={codes.codes} onDone={() => void onSignedIn(codes.session)} />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = value.replace(/\s/g, '');
    if (!useRecovery && !new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) {
      setError(t('mfa.codeFormat'));
      return;
    }
    setError(null);
    setPending(true);
    try {
      const session = await api.post<MfaSessionResponse>(
        '/admin/auth/mfa/verify',
        useRecovery
          ? { mfaToken: challenge.mfaToken, recoveryCode: value.trim() }
          : { mfaToken: challenge.mfaToken, code },
        { noRefresh: true },
      );
      if (session.recoveryCodes?.length) {
        setCodes({ session, codes: session.recoveryCodes });
        setPending(false);
        return;
      }
      await onSignedIn(session);
    } catch (err) {
      setError(errorMessage(t, err));
      setPending(false);
    }
  }

  const enrolling = challenge.mode === 'ENROLL';
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <p className="cb-text-secondary">{enrolling ? t('mfa.enrollIntro') : t('mfa.verifyIntro')}</p>
      {enrolling && challenge.enrollment && <EnrollmentDetails {...challenge.enrollment} />}
      <label htmlFor={`${id}-code`} className="form-label">
        {useRecovery ? t('mfa.recoveryLabel') : t('mfa.codeLabel')}
      </label>
      <input
        id={`${id}-code`}
        className={`form-control form-control-lg ${useRecovery ? '' : 'text-center font-monospace'} ${error ? 'is-invalid' : ''}`}
        inputMode={useRecovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={useRecovery ? 40 : TOTP_DIGITS}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        autoFocus
      />
      {error && (
        <div id={`${id}-error`} className="invalid-feedback d-block" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-lg w-100 mt-3" disabled={pending}>
        {pending ? t('auth.verifying') : enrolling ? t('mfa.turnOnAndSignIn') : t('mfa.verify')}
      </button>
      <div className="d-flex flex-wrap justify-content-between gap-2 mt-3">
        {!enrolling && (
          <button
            type="button"
            className="btn btn-link px-0"
            onClick={() => {
              setUseRecovery((v) => !v);
              setValue('');
              setError(null);
            }}
          >
            {useRecovery ? t('mfa.useAuthenticator') : t('mfa.useRecovery')}
          </button>
        )}
        <button type="button" className="btn btn-link px-0" onClick={onRestart}>
          {t('mfa.startOver')}
        </button>
      </div>
    </form>
  );
}
