import type { AdminIntegrityEvent, AdminMediaAsset, MediaStatus } from '@cbi/shared-types';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatDuration, formatOffset } from './format';
import { useIntegrityEvents } from './queries';

const MEDIA_BADGE: Record<MediaStatus, string> = {
  RECORDING: 'text-bg-info',
  COMPLETE: 'text-bg-success',
  PARTIAL: 'text-bg-warning',
  FAILED: 'text-bg-danger',
};

export function MediaStatusBadge({ status }: { status: MediaStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${MEDIA_BADGE[status]}`}>{t(`privacy.mediaStatus.${status}`)}</span>
  );
}

export function DeletionState({ deletion }: { deletion: AdminMediaAsset['deletion'] }) {
  const { t, i18n } = useTranslation();
  if (deletion.status === 'NONE') {
    return <span className="small">{t('privacy.deletion.stored')}</span>;
  }
  return (
    <span className="badge text-bg-secondary">
      {deletion.at
        ? t('privacy.deletion.deletedAt', { at: formatDateTime(deletion.at, i18n.language) })
        : t('privacy.deletion.deleted')}
    </span>
  );
}

/** A neutral description of one browser event (an observation, never a judgement). */
function eventLabel(t: TFunction, event: AdminIntegrityEvent) {
  switch (event.type) {
    case 'TAB_VISIBLE':
    case 'WINDOW_FOCUS':
      return event.value === null
        ? t(`privacy.integrity.events.${event.type}`)
        : t(`privacy.integrity.events.${event.type}_after`, {
            duration: formatDuration(t, event.value),
          });
    case 'PASTE':
      return event.value === null
        ? t('privacy.integrity.events.PASTE')
        : t('privacy.integrity.events.PASTE_count', { count: event.value });
    default:
      return t(`privacy.integrity.events.${event.type}`);
  }
}

export function IntegrityTimeline({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const events = useIntegrityEvents(sessionId);
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby="integrity-heading"
    >
      <h2 id="integrity-heading" className="h6">
        {t('privacy.integrity.title')}
      </h2>
      <p className="small cb-text-secondary">{t('privacy.integrity.note')}</p>
      {events.isPending && <LoadingRow />}
      {events.isError && <ErrorAlert error={consoleError(t, events.error)} />}
      {events.data && events.data.length === 0 && (
        <p className="small cb-text-secondary mb-0">{t('privacy.integrity.empty')}</p>
      )}
      {events.data && events.data.length > 0 && (
        <ol className="list-unstyled small mb-0" aria-label={t('privacy.integrity.listLabel')}>
          {events.data.map((event, i) => (
            <li key={i} className="d-flex gap-3 align-items-baseline mb-1">
              <time
                className="font-monospace cb-text-secondary"
                dateTime={event.at}
                title={formatDateTime(event.at, i18n.language)}
              >
                {formatOffset(event.offsetSec)}
              </time>
              <span>{eventLabel(t, event)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
