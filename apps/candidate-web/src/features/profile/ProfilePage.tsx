import type { OtpChannel } from '@cbi/shared-types';
import {
  errorMessage,
  GoogleSignInButton,
  OtpCodeForm,
  OtpRequestForm,
  type OtpRequested,
} from '@cbi/web-core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';
import { useAuthProviders, useCandidateApi } from '../auth/auth-api';
import { ConsentHistory } from '../consent/ConsentHistory';
import { ProfileForm } from './ProfileForm';

const PROVIDER_ICON = { EMAIL: 'bi-envelope', MOBILE: 'bi-phone', GOOGLE: 'bi-google' } as const;

function LinkIdentity({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useCandidateApi();
  const { setUser } = useCandidateAuth();
  const providers = useAuthProviders();
  const [requested, setRequested] = useState<OtpRequested | null>(null);
  const [error, setError] = useState<string | null>(null);
  const googleEnabled = Boolean(config.VITE_GOOGLE_CLIENT_ID) && providers.data?.google.enabled;

  return (
    <div className="p-3 border cb-border rounded-3 cb-surface-muted mt-3">
      {requested ? (
        <OtpCodeForm
          sent={requested.response}
          submitLabel={t('profile.confirmLink')}
          verify={async (challengeId, code) => {
            setUser(await api.verifyLinkOtp(challengeId, code));
            onDone();
          }}
          resend={() => api.requestLinkOtp(requested.channel, requested.destination)}
          onChangeDestination={() => setRequested(null)}
        />
      ) : (
        <>
          <OtpRequestForm
            mobileEnabled={providers.data?.mobile.enabled ?? false}
            request={(channel: OtpChannel, destination: string) =>
              api.requestLinkOtp(channel, destination)
            }
            onRequested={setRequested}
          />
          {googleEnabled && (
            <div className="mt-3">
              <GoogleSignInButton
                clientId={config.VITE_GOOGLE_CLIENT_ID!}
                locale={i18n.resolvedLanguage}
                unavailableMessage={t('auth.googleUnavailable')}
                onCredential={async (idToken) => {
                  setError(null);
                  try {
                    setUser(await api.linkGoogle(idToken));
                    onDone();
                  } catch (err) {
                    setError(errorMessage(t, err));
                  }
                }}
              />
            </div>
          )}
          {error && (
            <div className="alert alert-danger mt-3 mb-0" role="alert">
              {error}
            </div>
          )}
        </>
      )}
      <button type="button" className="btn btn-link px-0 mt-2" onClick={onDone}>
        {t('profile.cancel')}
      </button>
    </div>
  );
}

export function ProfilePage() {
  const { t } = useTranslation();
  const { user, setUser, signOutEverywhere } = useCandidateAuth();
  const api = useCandidateApi();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkedNotice, setLinkedNotice] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  if (!user) return null;

  return (
    <div className="container py-5">
      <h1 className="h3 mb-4">{t('profile.title')}</h1>
      <div className="row g-4">
        <section className="col-lg-7" aria-labelledby="details-title">
          <div className="p-4 border cb-border rounded-3 bg-white">
            <h2 id="details-title" className="h5 mb-3">
              {t('profile.details')}
            </h2>
            {saved && (
              <div className="alert alert-success" role="status">
                {t('profile.saved')}
              </div>
            )}
            {error && (
              <div className="alert alert-danger" role="alert">
                {error}
              </div>
            )}
            <ProfileForm
              user={user}
              submitLabel={t('profile.save')}
              pendingLabel={t('onboarding.saving')}
              onSubmit={async (body) => {
                setSaved(false);
                setError(null);
                try {
                  setUser(await api.updateProfile(body));
                  setSaved(true);
                } catch (err) {
                  setError(errorMessage(t, err));
                }
              }}
            />
          </div>
        </section>

        <div className="col-lg-5 d-flex flex-column gap-4">
          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby="methods-title"
          >
            <h2 id="methods-title" className="h5">
              {t('profile.signInMethods')}
            </h2>
            <p className="small cb-text-secondary">{t('profile.signInMethodsHint')}</p>
            {linkedNotice && (
              <div className="alert alert-success py-2" role="status">
                {t('profile.linkedSuccess')}
              </div>
            )}
            <ul className="list-group">
              {user.identities.map((identity) => (
                <li
                  key={`${identity.provider}-${identity.display}`}
                  className="list-group-item d-flex align-items-center gap-2"
                >
                  <i className={`bi ${PROVIDER_ICON[identity.provider]}`} aria-hidden="true" />
                  <span className="visually-hidden">
                    {t(`profile.providers.${identity.provider}`)}:
                  </span>
                  <span className="flex-grow-1 text-break">{identity.display}</span>
                  <span className="badge text-bg-light border cb-border">
                    <i className="bi bi-patch-check me-1" aria-hidden="true" />
                    {t('profile.verified')}
                  </span>
                </li>
              ))}
            </ul>
            {linking ? (
              <LinkIdentity
                onDone={() => {
                  setLinking(false);
                  setLinkedNotice(true);
                }}
              />
            ) : (
              <button
                type="button"
                className="btn btn-outline-primary mt-3"
                onClick={() => {
                  setLinkedNotice(false);
                  setLinking(true);
                }}
              >
                <i className="bi bi-plus-lg me-1" aria-hidden="true" />
                {t('profile.addMethod')}
              </button>
            )}
          </section>

          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby="security-title"
          >
            <h2 id="security-title" className="h5">
              {t('profile.security')}
            </h2>
            <p className="small cb-text-secondary">{t('profile.signOutEverywhereHint')}</p>
            {confirmingSignOut ? (
              <div className="d-flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={async () => {
                    await signOutEverywhere().catch(() => undefined);
                    await navigate('/', { replace: true });
                  }}
                >
                  {t('profile.confirmSignOutEverywhere')}
                </button>
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => setConfirmingSignOut(false)}
                >
                  {t('profile.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-outline-danger"
                onClick={() => setConfirmingSignOut(true)}
              >
                {t('profile.signOutEverywhere')}
              </button>
            )}
          </section>

          <ConsentHistory />
        </div>
      </div>
    </div>
  );
}
