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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { useAdminAuth } from '../../app/session';
import { config } from '../../config';

export function LoginPage() {
  const { t } = useTranslation();
  const { manager, completeSignIn } = useAdminAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
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
                <OtpRequestForm
                  mobileEnabled={providers.data?.mobile.enabled ?? false}
                  request={requestOtp}
                  onRequested={setRequested}
                />
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
