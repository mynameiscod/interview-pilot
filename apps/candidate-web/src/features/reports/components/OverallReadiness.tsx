import type { ReportContent } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONFIDENCE_ICON, percent } from '../report-format';

type Overall = ReportContent['overall'];

/** A semicircle gauge; the score and band are also given as text next to it. */
export function ReadinessGauge({ score, label }: { score: number | null; label: string }) {
  const value = score === null ? 0 : Math.max(0, Math.min(100, score));
  const arc = 'M 20 100 A 80 80 0 0 1 180 100';
  return (
    <svg
      viewBox="0 0 200 115"
      width="220"
      role="img"
      aria-label={label}
      className="d-block mx-auto"
      style={{ maxWidth: '100%' }}
    >
      <path
        d={arc}
        fill="none"
        stroke="var(--cb-surface-muted)"
        strokeWidth="18"
        strokeLinecap="round"
      />
      {score !== null && value > 0 && (
        <path
          d={arc}
          fill="none"
          stroke="var(--cb-primary)"
          strokeWidth="18"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${value} 100`}
        />
      )}
      <text
        x="100"
        y="92"
        textAnchor="middle"
        fontSize="36"
        fontWeight="600"
        fill="var(--cb-text-primary)"
        aria-hidden="true"
      >
        {score === null ? '–' : score}
      </text>
      <text
        x="100"
        y="110"
        textAnchor="middle"
        fontSize="11"
        fill="var(--cb-text-secondary)"
        aria-hidden="true"
      >
        / 100
      </text>
    </svg>
  );
}

const FACTORS = [
  'independentQuestions',
  'practicalEvidence',
  'consistency',
  'completeness',
] as const;

/** Evidence confidence as an icon + text chip, with the factors behind it on demand. */
export function ConfidenceChip({ confidence }: { confidence: Overall['confidence'] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <p className="mb-2">
        <span className="badge text-bg-light border cb-border fs-6 fw-normal">
          <i className={`bi ${CONFIDENCE_ICON[confidence.level]} me-2`} aria-hidden="true" />
          {t('report.confidence.chip', { level: t(`report.confidence.${confidence.level}`) })}
        </span>
      </p>
      <button
        type="button"
        className="btn btn-link p-0 text-decoration-none d-inline-flex align-items-center gap-2"
        aria-expanded={open}
        aria-controls={`${id}-factors`}
        onClick={() => setOpen((v) => !v)}
      >
        <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} aria-hidden="true" />
        {t('report.confidence.whatAffects')}
      </button>
      <div id={`${id}-factors`} hidden={!open} className="mt-2">
        <p className="small cb-text-secondary">{t('report.confidence.explain')}</p>
        <ul className="list-unstyled mb-0">
          {FACTORS.map((factor) => {
            const value = percent(confidence.factors[factor]);
            return (
              <li key={factor} className="mb-2">
                <div className="d-flex justify-content-between gap-2 small">
                  <span>{t(`report.confidence.factors.${factor}`)}</span>
                  <span className="fw-semibold">{t('report.percent', { value })}</span>
                </div>
                <div className="progress" style={{ height: '0.4rem' }} aria-hidden="true">
                  <div className="progress-bar bg-secondary" style={{ width: `${value}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function OverallReadiness({ overall }: { overall: Overall }) {
  const { t } = useTranslation();
  const band = t(`report.band.${overall.band}`);
  const insufficient = overall.score === null || overall.band === 'INSUFFICIENT_EVIDENCE';
  const gaugeLabel =
    overall.score === null
      ? t('report.gaugeLabelNone', { band })
      : t('report.gaugeLabel', { score: overall.score, band });
  const assessed = percent(overall.assessedWeight);

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="overall-title">
      <h2 id="overall-title" className="h5">
        {t('report.overallTitle')}
      </h2>
      <div className="row g-4 align-items-center">
        <div className="col-md-5 text-center">
          <ReadinessGauge score={overall.score} label={gaugeLabel} />
          <p className="fs-5 fw-semibold mb-0 mt-2">{band}</p>
          {overall.score !== null && (
            <p className="small cb-text-secondary mb-0">
              {t('report.scoreOutOf', { score: overall.score })}
            </p>
          )}
        </div>
        <div className="col-md-7">
          {insufficient ? (
            <div className="alert alert-light border cb-border" role="note">
              <h3 className="h6">{t('report.insufficient.title')}</h3>
              <p className="mb-0">{t('report.insufficient.body')}</p>
            </div>
          ) : (
            assessed < 100 && (
              <p className="small cb-text-secondary">{t('report.assessedWeight', { assessed })}</p>
            )
          )}
          <h3 className="h6">{t('report.confidence.title')}</h3>
          <ConfidenceChip confidence={overall.confidence} />
        </div>
      </div>
    </section>
  );
}
