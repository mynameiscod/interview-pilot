import type { PublicSystemStatus } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { systemKeys, useSystemStatus } from '../app/system-api';
import { useCandidateAuth } from '../app/session';

/** Session storage key: the maintenance message the candidate dismissed. */
export const MAINTENANCE_DISMISSED_KEY = 'cbi.maintenanceDismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(MAINTENANCE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** The admin's notice from a 503 MAINTENANCE body (`details.maintenance.message`). */
function noticeOf(details: unknown): string {
  const m = (details as { maintenance?: { message?: unknown } } | undefined)?.maintenance;
  return typeof m?.message === 'string' ? m.message : '';
}

/**
 * Site-wide notice while maintenance mode is on (reads work; new interviews
 * and other changes are refused). Dismissing hides it for this browser
 * session until the message changes. A request refused with 503
 * MAINTENANCE turns the notice on at once (without waiting for the next
 * status poll) and shows it again even if it was dismissed.
 */
export function MaintenanceBanner() {
  const { t } = useTranslation();
  const { manager } = useCandidateAuth();
  const queryClient = useQueryClient();
  const status = useSystemStatus();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  useEffect(
    () =>
      manager.onApiError((err) => {
        if (err.code !== 'MAINTENANCE') return;
        queryClient.setQueryData<PublicSystemStatus>(systemKeys.status, {
          maintenance: { enabled: true, message: noticeOf(err.details) },
        });
        try {
          sessionStorage.removeItem(MAINTENANCE_DISMISSED_KEY);
        } catch {
          // Storage blocked: the state below is enough.
        }
        setDismissed(null);
      }),
    [manager, queryClient],
  );

  const maintenance = status.data?.maintenance;
  if (!maintenance?.enabled) return null;
  const message = maintenance.message.trim();
  // Dismissal is remembered per message, so a changed notice shows again.
  const marker = message || '-';
  if (dismissed === marker) return null;

  function dismiss() {
    try {
      sessionStorage.setItem(MAINTENANCE_DISMISSED_KEY, marker);
    } catch {
      // Storage blocked: hide it for this page only.
    }
    setDismissed(marker);
  }

  return (
    <div className="alert alert-warning rounded-0 border-0 border-bottom mb-0 py-2" role="status">
      <div className="container d-flex align-items-start gap-2">
        <i className="bi bi-tools mt-1" aria-hidden="true" />
        <div className="flex-grow-1">
          <strong>{t('maintenance.title')}</strong>{' '}
          {message ? (
            <>
              <span>{message}</span> {t('maintenance.readOnly')}
            </>
          ) : (
            t('maintenance.fallback')
          )}
        </div>
        <button
          type="button"
          className="btn-close"
          aria-label={t('maintenance.dismiss')}
          onClick={dismiss}
        />
      </div>
    </div>
  );
}
