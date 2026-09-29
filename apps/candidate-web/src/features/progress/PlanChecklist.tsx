import { PlanBucket, type CurrentPlan } from '@cbi/shared-types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../interviews/messages';
import { useUpdatePlanItem } from './progress-api';
import { drillPath } from './progress-format';

/** The latest report's plan as a checklist; each item with a skill can be practised as a drill. */
export function PlanChecklist({ plan }: { plan: CurrentPlan }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const update = useUpdatePlanItem();
  const total = plan.items.length;
  const percent = total ? Math.round((plan.doneCount / total) * 100) : 0;

  return (
    <section className="cb-dash-card h-100" aria-labelledby={`${id}-title`}>
      <div className="d-flex flex-wrap align-items-baseline justify-content-between gap-2">
        <h2 id={`${id}-title`} className="h5 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-list-check text-secondary" aria-hidden="true" />
          {t('progress.plan.title')}
        </h2>
        <Link to={`/app/reports/${plan.sessionId}`} className="small fw-semibold">
          {t('progress.plan.openReport')}
        </Link>
      </div>
      <p className="small cb-text-secondary mb-2">
        {t('progress.plan.from', {
          title: plan.title,
          date: formatDate(i18n.resolvedLanguage, plan.generatedAt),
        })}
      </p>
      <p className="small mb-1" id={`${id}-progress`}>
        {t('progress.plan.done', { done: plan.doneCount, total })}
      </p>
      <div
        className="progress mb-3"
        role="progressbar"
        aria-labelledby={`${id}-progress`}
        aria-valuenow={plan.doneCount}
        aria-valuemin={0}
        aria-valuemax={total}
        style={{ height: '0.5rem' }}
      >
        <div className="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      {update.isError && (
        <div className="alert alert-danger py-2 small" role="alert">
          {t('progress.plan.saveError')}
        </div>
      )}
      {PlanBucket.options.map((bucket) => {
        const items = plan.items.filter((i) => i.bucket === bucket);
        if (items.length === 0) return null;
        return (
          <div key={bucket} className="mb-2">
            <h3 className="h6 small text-uppercase cb-text-secondary mb-1">
              {t(`report.plan.tabs.${bucket}`)}
            </h3>
            <ul className="list-unstyled mb-0">
              {items.map((item) => {
                const inputId = `${id}-${item.id}`;
                return (
                  <li
                    key={item.id}
                    className="cb-dash-row d-flex flex-wrap align-items-start gap-2 py-2"
                  >
                    <div className="form-check flex-grow-1 mb-0" style={{ minWidth: '12rem' }}>
                      <input
                        id={inputId}
                        className="form-check-input"
                        type="checkbox"
                        checked={item.done}
                        onChange={(e) =>
                          update.mutate({
                            sessionId: plan.sessionId,
                            revision: plan.revision,
                            itemId: item.id,
                            done: e.currentTarget.checked,
                          })
                        }
                        aria-describedby={`${inputId}-why`}
                      />
                      <label
                        htmlFor={inputId}
                        className={`form-check-label ${item.done ? 'cb-plan-done' : ''}`}
                      >
                        {item.action}
                      </label>
                      <div id={`${inputId}-why`} className="small cb-text-secondary">
                        {item.why}
                      </div>
                    </div>
                    {item.dimensionKey && item.dimensionName && (
                      <Link
                        to={drillPath(item.dimensionKey)}
                        className="btn btn-sm btn-outline-primary"
                        aria-label={t('progress.practiseNamed', { name: item.dimensionName })}
                      >
                        <i className="bi bi-lightning-charge me-1" aria-hidden="true" />
                        {t('progress.plan.practise')}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
