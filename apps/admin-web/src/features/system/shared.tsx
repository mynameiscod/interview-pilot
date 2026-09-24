import type { QueueCounts } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { queueLabel } from './format';

const COUNTS = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

/** Job counts per queue; with `onShowFailed`, each queue with failures gets a button. */
export function QueueCountsTable({
  queues,
  selected,
  onShowFailed,
}: {
  queues: QueueCounts[];
  selected?: string | null;
  onShowFailed?: (name: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const cols = COUNTS.length + (onShowFailed ? 2 : 1);
  return (
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th scope="col">{t('system.queues.queue')}</th>
            {COUNTS.map((c) => (
              <th scope="col" className="text-end" key={c}>
                {t(`system.queues.counts.${c}`)}
              </th>
            ))}
            {onShowFailed && (
              <th scope="col">
                <span className="visually-hidden">{t('system.queues.actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {queues.length === 0 && (
            <tr>
              <td colSpan={cols} className="cb-text-secondary">
                {t('system.queues.empty')}
              </td>
            </tr>
          )}
          {queues.map((q) => (
            <tr key={q.name} className={selected === q.name ? 'table-active' : undefined}>
              <th scope="row" className="fw-normal">
                <code>{q.name}</code>
                {q.paused && (
                  <span className="badge text-bg-warning ms-2">{t('system.queues.paused')}</span>
                )}
                {queueLabel(t, q.name) && (
                  <span className="d-block small cb-text-secondary">{queueLabel(t, q.name)}</span>
                )}
              </th>
              {COUNTS.map((c) => (
                <td
                  key={c}
                  className={`text-end ${c === 'failed' && q.failed > 0 ? 'text-danger fw-semibold' : ''}`}
                >
                  {number.format(q[c])}
                </td>
              ))}
              {onShowFailed && (
                <td className="text-end">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    aria-pressed={selected === q.name}
                    onClick={() => onShowFailed(q.name)}
                  >
                    {t('system.queues.showFailed', { name: q.name })}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
