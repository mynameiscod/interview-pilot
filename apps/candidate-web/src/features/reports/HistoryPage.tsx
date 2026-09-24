import type { ReportHistoryItem } from '@cbi/shared-types';
import type { TFunction } from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { formatDate, formatMinutes } from '../interviews/messages';
import { CONFIDENCE_ICON } from './report-format';
import { useReportHistory } from './reports-api';

const MAX_COMPARE = 4;

/** Why the picked attempts cannot be compared, or null when they can. */
function compareProblem(t: TFunction, picked: readonly ReportHistoryItem[]): string | null {
  if (picked.length < 2) return t('history.compareNeedTwo');
  if (picked.length > MAX_COMPARE) return t('history.compareTooMany', { max: MAX_COMPARE });
  const role = picked[0]!.roleKey;
  if (!role || picked.some((p) => p.roleKey !== role)) return t('history.compareSameRole');
  return null;
}

/** Screen 25: every report, newest first, with 2–4 attempts of one role picked for comparison. */
export function HistoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const history = useReportHistory();
  const [selected, setSelected] = useState<string[]>([]);
  const hintId = useId();

  const items = history.data ?? [];
  const picked = items.filter((item) => selected.includes(item.sessionId));
  const problem = compareProblem(t, picked);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const compare = () => {
    // Oldest first, the order the comparison shows them in.
    const ids = [...picked].reverse().map((p) => p.sessionId);
    void navigate(`/app/compare?sessions=${ids.map(encodeURIComponent).join(',')}`);
  };

  const dateOf = (item: ReportHistoryItem) =>
    item.endedAt ? formatDate(i18n.resolvedLanguage, item.endedAt) : '–';

  return (
    <div className="container py-5">
      <h1 className="h3">{t('history.title')}</h1>
      <p className="cb-text-secondary">{t('history.subtitle')}</p>

      {history.isPending && <p className="cb-text-secondary">{t('common.loading')}</p>}
      {history.isError && (
        <div className="alert alert-danger" role="alert">
          {t('history.error')}
        </div>
      )}
      {history.data && items.length === 0 && (
        <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="empty-title">
          <h2 id="empty-title" className="h5">
            {t('history.emptyTitle')}
          </h2>
          <p className="cb-text-secondary">{t('history.emptyBody')}</p>
          <Link to="/app/new" className="btn btn-primary">
            {t('dashboard.startCta')}
          </Link>
        </section>
      )}
      {items.length > 0 && (
        <section className="p-4 border cb-border rounded-3 bg-white">
          <div className="table-responsive">
            <table className="table align-middle">
              <caption className="visually-hidden">{t('history.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">{t('history.select')}</span>
                  </th>
                  <th scope="col">{t('history.role')}</th>
                  <th scope="col">{t('history.company')}</th>
                  <th scope="col">{t('history.date')}</th>
                  <th scope="col">{t('history.overall')}</th>
                  <th scope="col">{t('history.confidence')}</th>
                  <th scope="col">{t('history.duration')}</th>
                  <th scope="col">{t('history.language')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.sessionId}>
                    <td>
                      <input
                        type="checkbox"
                        className="form-check-input"
                        checked={selected.includes(item.sessionId)}
                        onChange={() => toggle(item.sessionId)}
                        aria-label={t('history.selectNamed', {
                          title: item.title,
                          date: dateOf(item),
                        })}
                      />
                    </td>
                    <th scope="row" className="fw-normal">
                      <Link
                        to={`/app/reports/${item.sessionId}`}
                        aria-label={t('history.openNamed', {
                          title: item.title,
                          date: dateOf(item),
                        })}
                      >
                        {item.title}
                      </Link>
                    </th>
                    <td>{item.companyName ?? '–'}</td>
                    <td className="text-nowrap">{dateOf(item)}</td>
                    <td>
                      {item.overall !== null && (
                        <span className="fw-semibold me-1">
                          {t('report.scoreOutOf', { score: item.overall })}
                        </span>
                      )}
                      <span className="d-block small">{t(`report.band.${item.band}`)}</span>
                    </td>
                    <td className="text-nowrap">
                      <i
                        className={`bi ${CONFIDENCE_ICON[item.confidence]} me-1`}
                        aria-hidden="true"
                      />
                      {t(`report.confidence.${item.confidence}`)}
                    </td>
                    <td className="text-nowrap">{formatMinutes(t, item.durationSec)}</td>
                    <td>{t(`profileForm.languages.${item.language}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="d-flex flex-wrap align-items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={problem !== null}
              aria-describedby={hintId}
              onClick={compare}
            >
              {t('history.compare')}
            </button>
            <p id={hintId} className="small cb-text-secondary mb-0" aria-live="polite">
              {problem ?? t('history.compareReady', { count: picked.length })}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
