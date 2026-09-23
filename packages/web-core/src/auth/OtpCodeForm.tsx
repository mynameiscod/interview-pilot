import { OTP_LENGTH, type OtpRequestResponse } from '@cbi/shared-types';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from './errors';

interface Props {
  sent: OtpRequestResponse;
  verify: (challengeId: string, code: string) => Promise<void>;
  resend: () => Promise<OtpRequestResponse>;
  onChangeDestination: () => void;
  submitLabel?: string;
}

function secondsUntil(iso: string) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

/** Step 2 of OTP sign-in/linking: enter the 6-digit code, with resend. */
export function OtpCodeForm({
  sent: initial,
  verify,
  resend,
  onChangeDestination,
  submitLabel,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [sent, setSent] = useState(initial);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [wait, setWait] = useState(() => secondsUntil(initial.resendAvailableAt));

  useEffect(() => {
    setWait(secondsUntil(sent.resendAvailableAt));
    const timer = setInterval(() => setWait(secondsUntil(sent.resendAvailableAt)), 1000);
    return () => clearInterval(timer);
  }, [sent.resendAvailableAt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) {
      setError(t('auth.codeFormat'));
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await verify(sent.challengeId, code);
    } catch (err) {
      setError(errorMessage(t, err));
      setPending(false);
    }
  }

  async function onResend() {
    setError(null);
    setNotice(null);
    try {
      const next = await resend();
      setSent(next);
      setCode('');
      setNotice(t('auth.codeResent'));
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const inputId = `${id}-code`;
  const errorId = `${id}-error`;

  return (
    <form onSubmit={submit} noValidate>
      <p className="cb-text-secondary">{t('auth.verifySubtitle', { destination: sent.sentTo })}</p>
      <label htmlFor={inputId} className="form-label">
        {t('auth.codeLabel')}
      </label>
      <input
        id={inputId}
        className={`form-control form-control-lg text-center font-monospace ${error ? 'is-invalid' : ''}`}
        style={{ letterSpacing: '0.5em' }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d*"
        maxLength={OTP_LENGTH}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoFocus
      />
      {error && (
        <div id={errorId} className="invalid-feedback d-block" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="small text-success mt-2" role="status">
          <i className="bi bi-check-circle me-1" aria-hidden="true" />
          {notice}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-lg w-100 mt-3" disabled={pending}>
        {pending ? t('auth.verifying') : (submitLabel ?? t('auth.verify'))}
      </button>
      <div className="d-flex flex-wrap justify-content-between gap-2 mt-3">
        <button type="button" className="btn btn-link px-0" onClick={onChangeDestination}>
          {t('auth.changeDestination')}
        </button>
        <button type="button" className="btn btn-link px-0" onClick={onResend} disabled={wait > 0}>
          {wait > 0 ? t('auth.resendIn', { seconds: wait }) : t('auth.resend')}
        </button>
      </div>
    </form>
  );
}
