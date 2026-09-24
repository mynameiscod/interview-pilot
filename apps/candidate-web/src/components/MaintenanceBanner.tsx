import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemStatus } from '../app/system-api';

/** Session storage key: the maintenance message the candidate dismissed. */
export const MAINTENANCE_DISMISSED_KEY = 'cbi.maintenanceDismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(MAINTENANCE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * Site-wide notice while maintenance mode is on (new interviews cannot be
 * started or joined; running ones continue). Dismissing hides it for this
 * browser session until the message changes.
 */
export function MaintenanceBanner() {
  const { t } = useTranslation();
  const status = useSystemStatus();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

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
          <strong>{t('maintenance.title')}</strong> {message || t('maintenance.fallback')}
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
