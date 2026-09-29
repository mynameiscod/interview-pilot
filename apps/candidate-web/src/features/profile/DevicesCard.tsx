import type { ActiveSession } from '@cbi/shared-types';
import { deviceName, errorMessage } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '../interviews/messages';
import { privacyKeys, useActiveSessions, usePrivacyApi } from '../privacy/privacy-api';

/** Signed-in devices with a per-device sign-out (profile page). */
export function DevicesCard() {
  const { t, i18n } = useTranslation();
  const api = usePrivacyApi();
  const queryClient = useQueryClient();
  const sessions = useActiveSessions();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(session: ActiveSession) {
    setNotice(null);
    setError(null);
    try {
      await api.revokeSession(session.id);
      queryClient.setQueryData<ActiveSession[]>(privacyKeys.sessions, (old = []) =>
        old.filter((s) => s.id !== session.id),
      );
      setNotice(t('profile.deviceSignedOut'));
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const date = (iso: string) => formatDate(i18n.resolvedLanguage, iso);

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="devices-title">
      <h2 id="devices-title" className="h5">
        {t('profile.devicesTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('profile.devicesHint')}</p>
      {notice && (
        <div className="alert alert-success py-2" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {sessions.isPending && <p className="small mb-0">{t('common.loading')}</p>}
      {sessions.isError && <p className="small mb-0">{t('profile.devicesError')}</p>}
      {sessions.data && (
        <ul className="list-group">
          {sessions.data.map((session) => {
            const name = deviceName(session.userAgent) ?? t('profile.unknownDevice');
            return (
              <li
                key={session.id}
                className="list-group-item d-flex flex-wrap align-items-center gap-2"
              >
                <i className="bi bi-laptop" aria-hidden="true" />
                <div className="flex-grow-1">
                  <div className="fw-semibold">
                    {name}
                    {session.current && (
                      <span className="badge text-bg-light border cb-border ms-2">
                        {t('profile.thisDevice')}
                      </span>
                    )}
                  </div>
                  <div className="small cb-text-secondary">
                    {t('profile.deviceMeta', {
                      signedIn: date(session.signedInAt),
                      active: date(session.lastActiveAt),
                    })}
                  </div>
                </div>
                {!session.current && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    aria-label={t('profile.signOutDeviceNamed', { name })}
                    onClick={() => void revoke(session)}
                  >
                    {t('profile.signOutDevice')}
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
