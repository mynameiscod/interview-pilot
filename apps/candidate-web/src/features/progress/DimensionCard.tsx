import type { DimensionTrend, ProgressOverview } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { drillPath, signed } from './progress-format';

const WIDTH = 96;
const HEIGHT = 28;

/**
 * A tiny line of a dimension's scores (0–100), oldest first. Decorative: the
 * scores are in the table beside it. Colours come from CSS tokens.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2)
    return <span className="cb-sparkline cb-sparkline--empty" aria-hidden="true" />;
  const step = WIDTH / (values.length - 1);
  const y = (v: number) => 2 + (HEIGHT - 4) * (1 - Math.min(100, Math.max(0, v)) / 100);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg
      className="cb-sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={points} />
      <circle cx={WIDTH} cy={y(values.at(-1)!)} r="3" />
    </svg>
  );
}

function DimensionRow({ d }: { d: DimensionTrend }) {
  const { t } = useTranslation();
  return (
    <li className="cb-dash-row d-flex flex-wrap align-items-center gap-2 gap-sm-3 py-2">
      <div className="flex-grow-1" style={{ minWidth: '9rem' }}>
        <div className="fw-semibold small text-break">{d.name}</div>
        <div className="small cb-text-secondary">
          {d.latest === null ? t('progress.dimensions.notAssessed') : `${d.latest}/100`}
          {d.delta !== null && (
            <span className="ms-2">
              {t('progress.dimensions.change', { change: signed(d.delta) })}
            </span>
          )}
        </div>
      </div>
      <Sparkline values={d.points.map((p) => p.score)} />
      {d.current && (
        <Link
          to={drillPath(d.key)}
          className="btn btn-sm btn-outline-primary"
          aria-label={t('progress.practiseNamed', { name: d.name })}
        >
          {t('progress.practise')}
        </Link>
      )}
    </li>
  );
}

/** Each dimension of the focus role across interviews and drills, with a practise action. */
export function DimensionCard({ progress }: { progress: ProgressOverview }) {
  const { t } = useTranslation();
  const dims = progress.dimensions;
  return (
    <section className="cb-dash-card h-100" aria-labelledby="dims-title">
      <h2 id="dims-title" className="h5 mb-1 d-flex align-items-center gap-2">
        <i className="bi bi-bar-chart-line text-secondary" aria-hidden="true" />
        {t('progress.dimensions.title')}
      </h2>
      <p className="small cb-text-secondary mb-2">{t('progress.dimensions.subtitle')}</p>
      {dims.length === 0 ? (
        <p className="cb-text-secondary mb-0">{t('progress.dimensions.empty')}</p>
      ) : (
        <ul className="list-unstyled mb-0">
          {dims.map((d) => (
            <DimensionRow key={d.key} d={d} />
          ))}
        </ul>
      )}
      <table className="visually-hidden">
        <caption>{t('progress.dimensions.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('progress.dimensions.colSkill')}</th>
            <th scope="col">{t('progress.dimensions.colScores')}</th>
            <th scope="col">{t('progress.dimensions.colLatest')}</th>
            <th scope="col">{t('progress.dimensions.colChange')}</th>
          </tr>
        </thead>
        <tbody>
          {dims.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.name}</th>
              <td>
                {d.points.length
                  ? d.points
                      .map((p) =>
                        p.kind === 'DRILL'
                          ? t('progress.dimensions.drillScore', { score: p.score })
                          : String(p.score),
                      )
                      .join(', ')
                  : t('progress.notScored')}
              </td>
              <td>{d.latest ?? t('progress.notScored')}</td>
              <td>{d.delta === null ? '—' : signed(d.delta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
