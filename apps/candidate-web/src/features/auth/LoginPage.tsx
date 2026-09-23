import type { SessionResponse } from '@cbi/shared-types';
import {
  errorMessage,
  GoogleSignInButton,
  OtpCodeForm,
  OtpRequestForm,
  safeNextPath,
  type OtpRequested,
} from '@cbi/web-core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';
import { useAuthProviders, useCandidateApi } from './auth-api';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const api = useCandidateApi();
  const { completeSignIn } = useCandidateAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const providers = useAuthProviders();
  const [requested, setRequested] = useState<OtpRequested | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const next = safeNextPath(params.get('next'));

  async function finish(session: SessionResponse) {
    const user = await completeSignIn(session);
    navigate(user.onboardingCompleted ? next : `/onboarding?next=${encodeURIComponent(next)}`, {
      replace: true,
    });
  }

  const googleEnabled = Boolean(config.VITE_GOOGLE_CLIENT_ID) && providers.data?.google.enabled;

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-sm-10 col-md-7 col-lg-5">
          <h1 className="h3 mb-2">{requested ? t('auth.verifyTitle') : t('auth.loginTitle')}</h1>
          {!requested && <p className="cb-text-secondary">{t('auth.loginSubtitle')}</p>}

          <div className="p-4 border cb-border rounded-3 bg-white mt-3">
            {requested ? (
              <OtpCodeForm
                sent={requested.response}
                verify={async (challengeId, code) => finish(await api.verifyOtp(challengeId, code))}
                resend={() => api.requestOtp(requested.channel, requested.destination)}
                onChangeDestination={() => setRequested(null)}
              />
            ) : (
              <>
                <OtpRequestForm
                  mobileEnabled={providers.data?.mobile.enabled ?? false}
                  request={api.requestOtp}
                  onRequested={setRequested}
                />
                {googleEnabled && (
                  <>
                    <div className="d-flex align-items-center gap-2 my-4" aria-hidden="true">
                      <hr className="flex-grow-1 my-0" />
                      <span className="small cb-text-secondary">{t('auth.or')}</span>
                      <hr className="flex-grow-1 my-0" />
                    </div>
                    <GoogleSignInButton
                      clientId={config.VITE_GOOGLE_CLIENT_ID!}
                      locale={i18n.resolvedLanguage}
                      unavailableMessage={t('auth.googleUnavailable')}
                      onCredential={async (idToken) => {
                        setGoogleError(null);
                        try {
                          await finish(await api.google(idToken));
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
                  </>
                )}
              </>
            )}
          </div>
          <p className="small cb-text-secondary mt-3">{t('auth.noPassword')}</p>
        </div>
      </div>
    </div>
  );
}
