import type { OtpChannel, OtpRequestResponse } from '@cbi/shared-types';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from './errors';

export interface OtpRequested {
  channel: OtpChannel;
  destination: string;
  response: OtpRequestResponse;
}

interface Props {
  mobileEnabled: boolean;
  request: (channel: OtpChannel, destination: string) => Promise<OtpRequestResponse>;
  onRequested: (result: OtpRequested) => void;
  submitLabel?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Step 1 of OTP sign-in/linking: choose email or mobile and send a code. */
export function OtpRequestForm({ mobileEnabled, request, onRequested, submitLabel }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [channel, setChannel] = useState<OtpChannel>('EMAIL');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = destination.trim();
    const valid =
      channel === 'EMAIL' ? EMAIL_PATTERN.test(value) : value.replace(/\D/g, '').length >= 10;
    if (!valid) {
      setError(channel === 'EMAIL' ? t('errors.invalidEmail') : t('errors.invalidMobile'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await request(channel, value);
      onRequested({ channel, destination: value, response });
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  }

  const inputId = `${id}-destination`;
  const errorId = `${id}-error`;

  return (
    <form onSubmit={submit} noValidate>
      {mobileEnabled && (
        <div className="btn-group w-100 mb-3" role="group" aria-label={t('auth.channelLabel')}>
          {(['EMAIL', 'MOBILE'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`btn ${channel === option ? 'btn-primary' : 'btn-outline-primary'}`}
              aria-pressed={channel === option}
              onClick={() => {
                setChannel(option);
                setDestination('');
                setError(null);
              }}
            >
              <i
                className={`bi ${option === 'EMAIL' ? 'bi-envelope' : 'bi-phone'} me-2`}
                aria-hidden="true"
              />
              {option === 'EMAIL' ? t('auth.emailTab') : t('auth.mobileTab')}
            </button>
          ))}
        </div>
      )}
      <label htmlFor={inputId} className="form-label">
        {channel === 'EMAIL' ? t('auth.emailLabel') : t('auth.mobileLabel')}
      </label>
      <input
        id={inputId}
        className={`form-control form-control-lg ${error ? 'is-invalid' : ''}`}
        type={channel === 'EMAIL' ? 'email' : 'tel'}
        inputMode={channel === 'EMAIL' ? 'email' : 'tel'}
        autoComplete={channel === 'EMAIL' ? 'email' : 'tel'}
        placeholder={channel === 'EMAIL' ? t('auth.emailPlaceholder') : t('auth.mobilePlaceholder')}
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        required
      />
      {channel === 'MOBILE' && !error && <div className="form-text">{t('auth.mobileHint')}</div>}
      {error && (
        <div id={errorId} className="invalid-feedback d-block" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-lg w-100 mt-3" disabled={pending}>
        {pending ? t('auth.sending') : (submitLabel ?? t('auth.sendCode'))}
      </button>
    </form>
  );
}
