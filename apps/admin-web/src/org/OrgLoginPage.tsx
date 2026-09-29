import {
  isMfaChallenge,
  type AdminSignInResponse,
  type AuthProvidersResponse,
  type MfaChallenge,
  type OtpChannel,
  type OtpRequestResponse,
  type SessionResponse,
} from '@cbi/shared-types';
import {
  errorMessage,
  GoogleSignInButton,
  OtpCodeForm,
  OtpRequestForm,
  safeNextPath,
  toUiLocale,
  type OtpRequested,
} from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { config } from '../config';
import { MfaStep } from '../features/auth/MfaStep';
import { useOrgAuth } from './session';

/**
 * Org portal sign-in: an email (or SMS) code or Google, for members of an
 * organisation only; then the authenticator step when the organisation
 * requires it. Staff use the admin console sign-in instead.
 */
export function OrgLoginPage() {
  const { t, i18n } = useTranslation();
  const { manager, completeSignIn } = useOrgAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [requested, setRequested] = useState<OtpRequested | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const api = manager.api;
  const providers = useQuery({
    queryKey: ['org-auth', 'providers'],
    queryFn: () => api.get<AuthProvidersResponse>('/org/auth/providers'),
  });

  const requestOtp = (channel: OtpChannel, destination: string) =>
    api.post<OtpRequestResponse>(
      '/org/auth/otp/request',
      { channel, destination, lang: toUiLocale(i18n.resolvedLanguage) },
      { noRefresh: true },
    );

  async function complete(session: SessionResponse) {
    await completeSignIn(session);
    const next = safeNextPath(params.get('next'), '/org');
    navigate(next.startsWith('/org') ? next : '/org', { replace: true });
  }

  async function finish(result: AdminSignInResponse) {
    if (isMfaChallenge(result)) {
      setChallenge(result);
      return;
    }
    await complete(result);
  }

  const googleEnabled = Boolean(config.googleClientId) && providers.data?.google.enabled;

  return (
    <main id="main" className="container py-5">
      <div className="row justify-content-center">
        <div className="col-sm-10 col-md-7 col-lg-5">
          <h1 className="h3">
            {challenge
              ? challenge.mode === 'ENROLL'
                ? t('mfa.enrollTitle')
                : t('mfa.verifyTitle')
              : requested
                ? t('auth.verifyTitle')
                : t('orgPortal.login.title')}
          </h1>
          {!requested && !challenge && (
            <p className="cb-text-secondary">{t('orgPortal.login.subtitle')}</p>
          )}
          <div className="p-4 border cb-border rounded-3 bg-white mt-3">
            {challenge ? (
              <MfaStep
                api={api}
                challenge={challenge}
                verifyPath="/org/auth/mfa/verify"
                onSignedIn={complete}
                onRestart={() => {
                  setChallenge(null);
                  setRequested(null);
                }}
              />
            ) : requested ? (
              <OtpCodeForm
                sent={requested.response}
                verify={async (challengeId, code) =>
                  finish(
                    await api.post<AdminSignInResponse>(
                      '/org/auth/otp/verify',
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
                            await api.post<AdminSignInResponse>(
                              '/org/auth/google',
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
          <p className="small cb-text-secondary mt-3">{t('orgPortal.login.membersOnly')}</p>
        </div>
      </div>
    </main>
  );
}
