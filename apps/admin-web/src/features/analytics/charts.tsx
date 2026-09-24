import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Pattern = 'solid' | 'dashed' | 'dotted';

const DASH: Record<Pattern, string | undefined> = {
  solid: undefined,
  dashed: '6 4',
  dotted: '2 3',
};

export type ChartTone = 'primary' | 'success' | 'warning' | 'danger' | 'info';

export type ChartSeries = {
  key: string;
  label: string;
  values: number[];
  tone: ChartTone;
  /** A line pattern, so series differ by more than colour. */
  pattern?: Pattern;
};

const STROKE: Record<ChartTone, string> = {
  primary: 'var(--cb-primary)',
  success: 'var(--bs-success)',
  warning: 'var(--bs-warning)',
  danger: 'var(--bs-danger)',
  info: 'var(--bs-info)',
};

const W = 640;
const H = 200;
const PAD_X = 6;
const PAD_Y = 10;

function Swatch({ tone, pattern = 'solid' }: { tone: ChartTone; pattern?: Pattern }) {
  return (
    <svg width="24" height="10" aria-hidden="true" className="me-1 flex-shrink-0">
      <line
        x1="1"
        y1="5"
        x2="23"
        y2="5"
        stroke={STROKE[tone]}
        strokeWidth="3"
        strokeDasharray={DASH[pattern]}
      />
    </svg>
  );
}

/**
 * A small daily line chart drawn with inline SVG. The picture carries a text
 * summary for screen readers, and the exact values are one click away in a table.
 */
export function LineChart({
  title,
  days,
  series,
  format,
  formatDay,
}: {
  title: string;
  days: string[];
  series: ChartSeries[];
  format: (value: number) => string;
  formatDay: (day: string) => string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [showTable, setShowTable] = useState(false);
  const all = series.flatMap((s) => s.values);
  const min = Math.min(0, ...all);
  const rawMax = Math.max(0, ...all);
  const max = rawMax === min ? min + 1 : rawMax;
  const n = days.length;
  const x = (i: number) => PAD_X + (n <= 1 ? (W - 2 * PAD_X) / 2 : (i * (W - 2 * PAD_X)) / (n - 1));
  const y = (v: number) => PAD_Y + ((max - v) / (max - min)) * (H - 2 * PAD_Y);
  const summary = t('analytics.chart.summary', {
    title,
    count: n,
    from: n ? formatDay(days[0]!) : '',
    to: n ? formatDay(days[n - 1]!) : '',
    totals: series
      .map((s) => `${s.label} ${format(s.values.reduce((sum, v) => sum + v, 0))}`)
      .join(', '),
  });

  return (
    <section className="p-3 border cb-border rounded-3 bg-white h-100" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="h6">
        {title}
      </h3>
      {n === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('analytics.chart.empty')}</p>
      ) : (
        <>
          <ul className="list-unstyled d-flex flex-wrap gap-3 small mb-2">
            {series.map((s) => (
              <li key={s.key} className="d-flex align-items-center">
                <Swatch tone={s.tone} pattern={s.pattern} />
                {s.label}
              </li>
            ))}
          </ul>
          <div className="small cb-text-secondary" aria-hidden="true">
            {format(max)}
          </div>
          <svg
            role="img"
            aria-label={summary}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-100 d-block"
            style={{ height: '10rem' }}
          >
            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={y(max)}
              y2={y(max)}
              stroke="var(--cb-border)"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={y(0)}
              y2={y(0)}
              stroke="var(--cb-text-secondary)"
              vectorEffect="non-scaling-stroke"
            />
            {series.map((s) => (
              <g key={s.key}>
                <polyline
                  fill="none"
                  stroke={STROKE[s.tone]}
                  strokeWidth="2.5"
                  strokeDasharray={DASH[s.pattern ?? 'solid']}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                />
                {n <= 2 &&
                  s.values.map((v, i) => (
                    <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={STROKE[s.tone]} />
                  ))}
              </g>
            ))}
          </svg>
          <div
            className="d-flex justify-content-between small cb-text-secondary"
            aria-hidden="true"
          >
            <span>{formatDay(days[0]!)}</span>
            <span>{min < 0 ? format(min) : ''}</span>
            <span>{formatDay(days[n - 1]!)}</span>
          </div>
          <button
            type="button"
            className="btn btn-link btn-sm px-0"
            aria-expanded={showTable}
            aria-controls={`${id}-table`}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? t('analytics.chart.hideTable') : t('analytics.chart.showTable')}
          </button>
          <div id={`${id}-table`} className="table-responsive" hidden={!showTable}>
            <table className="table table-sm small mb-0">
              <caption className="visually-hidden">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('analytics.chart.day')}</th>
                  {series.map((s) => (
                    <th scope="col" className="text-end" key={s.key}>
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((day, i) => (
                  <tr key={day}>
                    <th scope="row" className="fw-normal text-nowrap">
                      {formatDay(day)}
                    </th>
                    {series.map((s) => (
                      <td className="text-end" key={s.key}>
                        {format(s.values[i] ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
