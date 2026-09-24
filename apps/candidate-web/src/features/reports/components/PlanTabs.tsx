import type { ReportContent } from '@cbi/shared-types';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

const TABS = ['next24h', 'next3Days', 'next7Days'] as const;
type Tab = (typeof TABS)[number];

/** Screen 24: the improvement plan as ARIA tabs (arrow keys, Home and End move between them). */
export function PlanTabs({ plan }: { plan: ReportContent['plan'] }) {
  const { t } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState<Tab>('next24h');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next]!);
    tabRefs.current[next]?.focus();
  };

  const items = plan[tab];
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="plan-title">
      <h2 id="plan-title" className="h5">
        {t('report.plan.title')}
      </h2>
      <div className="nav nav-tabs mb-3" role="tablist" aria-label={t('report.plan.tabsLabel')}>
        {TABS.map((value, index) => (
          <button
            key={value}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            id={`${id}-tab-${value}`}
            type="button"
            role="tab"
            className={`nav-link ${tab === value ? 'active' : ''}`}
            aria-selected={tab === value}
            aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(e) => onKey(e, index)}
          >
            {t(`report.plan.tabs.${value}`)}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        {items.length === 0 ? (
          <p className="cb-text-secondary mb-0">{t('report.plan.empty')}</p>
        ) : (
          <ol className="mb-0 ps-3">
            {items.map((item, index) => (
              <li key={index} className="mb-3">
                <p className="fw-semibold mb-1">{item.action}</p>
                <p className="small cb-text-secondary mb-0">
                  <span className="visually-hidden">{t('report.plan.why')}: </span>
                  {item.why}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
