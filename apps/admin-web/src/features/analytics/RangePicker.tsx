import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { presetRange, PRESETS, rangeProblem, type DayRange } from './format';

function CustomRange({ range, onChange }: { range: DayRange; onChange: (r: DayRange) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="d-flex flex-wrap align-items-end gap-2"
      aria-label={t('analytics.range.custom')}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const next = { from, to };
        const found = rangeProblem(next);
        setProblem(found);
        if (!found) onChange(next);
      }}
    >
      <div>
        <label htmlFor={`${id}-from`} className="form-label small mb-1">
          {t('analytics.range.from')}
        </label>
        <input
          id={`${id}-from`}
          type="date"
          className="form-control form-control-sm"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
        />
      </div>
      <div>
        <label htmlFor={`${id}-to`} className="form-label small mb-1">
          {t('analytics.range.to')}
        </label>
        <input
          id={`${id}-to`}
          type="date"
          className="form-control form-control-sm"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
        />
      </div>
      <button type="submit" className="btn btn-sm btn-outline-primary">
        {t('analytics.range.apply')}
      </button>
      {problem && (
        <div id={`${id}-error`} className="invalid-feedback d-block w-100" role="alert">
          {t(problem)}
        </div>
      )}
    </form>
  );
}

/** Presets (7/30/90 days, ending today in India time) and a custom from–to range. */
export function RangePicker({
  range,
  onChange,
}: {
  range: DayRange;
  onChange: (next: DayRange) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const active = PRESETS.find((days) => {
    const preset = presetRange(days);
    return preset.from === range.from && preset.to === range.to;
  });
  return (
    <div className="d-flex flex-wrap align-items-end gap-3 mb-3">
      <div>
        <div className="form-label small mb-1" id={`${id}-presets`}>
          {t('analytics.range.label')}
        </div>
        <div className="btn-group btn-group-sm" role="group" aria-labelledby={`${id}-presets`}>
          {PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              className={`btn ${active === days ? 'btn-primary' : 'btn-outline-primary'}`}
              aria-pressed={active === days}
              onClick={() => onChange(presetRange(days))}
            >
              {t('analytics.range.lastDays', { count: days })}
            </button>
          ))}
        </div>
      </div>
      {/* Re-mount on change so the inputs show the applied range. */}
      <CustomRange key={`${range.from}:${range.to}`} range={range} onChange={onChange} />
    </div>
  );
}
