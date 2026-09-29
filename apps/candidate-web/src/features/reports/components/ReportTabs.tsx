import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface ReportTab<K extends string> {
  key: K;
  label: string;
  icon: string;
  panel: ReactNode;
}

/**
 * The report's sections as ARIA tabs (arrow keys, Home and End move between
 * them). On small screens the tab row scrolls sideways instead of wrapping.
 * Only the selected panel is rendered.
 */
export function ReportTabs<K extends string>({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: readonly ReportTab<K>[];
  selected: K;
  onSelect: (key: K) => void;
  label: string;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = tabs.find((tab) => tab.key === selected) ?? tabs[0]!;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(tabs[next]!.key);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div
        className="nav nav-tabs flex-nowrap overflow-auto mb-4"
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab, index) => {
          const active = tab.key === current.key;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                refs.current[index] = el;
              }}
              id={`${id}-tab-${tab.key}`}
              type="button"
              role="tab"
              className={`nav-link text-nowrap ${active ? 'active' : ''}`}
              aria-selected={active}
              aria-controls={`${id}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.key)}
              onKeyDown={(e) => onKey(e, index)}
            >
              <i className={`bi ${tab.icon} me-2`} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${current.key}`}
        tabIndex={0}
        className="d-flex flex-column gap-4"
      >
        {current.panel}
      </div>
    </div>
  );
}
