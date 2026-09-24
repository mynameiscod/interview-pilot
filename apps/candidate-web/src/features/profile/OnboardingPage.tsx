import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';

import { useCandidateAuth } from '../../app/session';
import { useCandidateApi } from '../auth/auth-api';
import { errorMessage, safeNextPath } from '@cbi/web-core';
import { ProfileForm } from './ProfileForm';

export function OnboardingPage() {
  const { t } = useTranslation();
  const { user, setUser } = useCandidateAuth();
  const api = useCandidateApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  // Also reached right after saving (setUser re-renders first): continue to `next`.
  const next = safeNextPath(params.get('next'));
  if (!user) return null;
  if (user.onboardingCompleted) return <Navigate to={next} replace />;

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-md-8 col-lg-6">
          <h1 className="h3">{t('onboarding.title')}</h1>
          <p className="cb-text-secondary">{t('onboarding.subtitle')}</p>
          {error && (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <div className="p-4 border cb-border rounded-3 bg-white">
            <ProfileForm
              user={user}
              submitLabel={t('onboarding.save')}
              pendingLabel={t('onboarding.saving')}
              onSubmit={async (body) => {
                setError(null);
                try {
                  setUser(await api.updateProfile(body));
                  navigate(next, { replace: true });
                } catch (err) {
                  setError(errorMessage(t, err));
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
