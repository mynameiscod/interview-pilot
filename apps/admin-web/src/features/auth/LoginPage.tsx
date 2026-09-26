import type {
  AuthProvidersResponse,
  OtpChannel,
  OtpRequestResponse,
  SessionResponse,
} from '@cbi/shared-types';
import {
  errorMessage,
  GoogleSignInButton,
  OtpCodeForm,
  OtpRequestForm,
  safeNextPath,
  type OtpRequested,
} from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { useAdminAuth } from '../../app/session';
import { config } from '../../config';

export function LoginPage() {
  const { t } = useTranslation();
  const { manager, completeSignIn } = useAdminAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [method, setMethod] = useState<'password' | 'code'>('password');
  const [requested, setRequested] = useState<OtpRequested | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const api = manager.api;
  const providers = useQuery({
    queryKey: ['admin-auth', 'providers'],
    queryFn: () => api.get<AuthProvidersResponse>('/admin/auth/providers'),
  });

  const requestOtp = (channel: OtpChannel, destination: string) =>
    api.post<OtpRequestResponse>(
      '/admin/auth/otp/request',
      { channel, destination },
      { noRefresh: true },
    );

  async function finish(session: SessionResponse) {
    await completeSignIn(session);
    navigate(safeNextPath(params.get('next'), '/'), { replace: true });
  }

  const googleEnabled = Boolean(config.googleClientId) && providers.data?.google.enabled;

  const methodSwitch = (
    <div className="btn-group w-100 mb-4" role="group" aria-label={t('auth.methodLabel')}>
      {(['password', 'code'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className={`btn ${method === m ? 'btn-primary' : 'btn-outline-primary'}`}
          aria-pressed={method === m}
          onClick={() => setMethod(m)}
        >
          {t(m === 'password' ? 'auth.methodPassword' : 'auth.methodCode')}
        </button>
      ))}
    </div>
  );

  return (
    <main id="main" className="container py-5">
      <div className="row justify-content-center">
        <div className="col-sm-10 col-md-7 col-lg-5">
          <h1 className="h3">{requested ? t('auth.verifyTitle') : t('auth.loginTitle')}</h1>
          {!requested && <p className="cb-text-secondary">{t('auth.loginSubtitle')}</p>}
          <div className="p-4 border cb-border rounded-3 bg-white mt-3">
            {requested ? (
              <OtpCodeForm
                sent={requested.response}
                verify={async (challengeId, code) =>
                  finish(
                    await api.post<SessionResponse>(
                      '/admin/auth/otp/verify',
                      { challengeId, code },
                      { noRefresh: true },
                    ),
                  )
                }
                resend={() => requestOtp(requested.channel, requested.destination)}
                onChangeDestination={() => setRequested(null)}
              />
            ) : (
              <>
                {methodSwitch}
                {method === 'password' ? (
                  <PasswordForm
                    signIn={async (email, password) =>
                      finish(
                        await api.post<SessionResponse>(
                          '/admin/auth/password/login',
                          { email, password },
                          { noRefresh: true },
                        ),
                      )
                    }
                  />
                ) : (
                  <OtpRequestForm
                    mobileEnabled={providers.data?.mobile.enabled ?? false}
                    request={requestOtp}
                    onRequested={setRequested}
                  />
                )}
                {googleEnabled && (
                  <div className="mt-4">
                    <GoogleSignInButton
                      clientId={config.googleClientId!}
                      unavailableMessage={t('auth.googleUnavailable')}
                      onCredential={async (idToken) => {
                        setGoogleError(null);
                        try {
                          await finish(
                            await api.post<SessionResponse>(
                              '/admin/auth/google',
                              { idToken },
                              { noRefresh: true },
                            ),
                          );
                        } catch (err) {
                          setGoogleError(errorMessage(t, err));
                        }
                      }}
                    />
                    {googleError && (
                      <div className="alert alert-danger mt-3 mb-0" role="alert">
                        {googleError}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <p className="small cb-text-secondary mt-3">{t('auth.staffOnly')}</p>
        </div>
      </div>
    </main>
  );
}

function PasswordForm({ signIn }: { signIn: (email: string, password: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(errorMessage(t, err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <div className="mb-3">
        <label htmlFor="admin-email" className="form-label">
          {t('auth.emailLabel')}
        </label>
        <input
          id="admin-email"
          type="email"
          className="form-control"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="mb-3">
        <label htmlFor="admin-password" className="form-label">
          {t('auth.password')}
        </label>
        <input
          id="admin-password"
          type="password"
          className="form-control"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}
      <button
        type="submit"
        className="btn btn-primary w-100"
        disabled={pending || !email.trim() || !password}
      >
        {pending ? t('auth.signingIn') : t('auth.signIn')}
      </button>
    </form>
  );
}
