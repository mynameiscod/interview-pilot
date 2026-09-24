import type { ReportDimension } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scoreText, sortDimensions, STRENGTH_ICON, strengthKey } from '../report-format';

function EvidenceList({ dimension }: { dimension: ReportDimension }) {
  const { t } = useTranslation();
  if (dimension.evidence.length === 0) {
    return <p className="small cb-text-secondary mb-0">{t('report.dimensions.noEvidence')}</p>;
  }
  return (
    <>
      <h4 className="h6 mt-3">{t('report.dimensions.evidenceTitle')}</h4>
      <ul className="list-unstyled mb-0">
        {dimension.evidence.map((item) => {
          const key = strengthKey(item.strength);
          return (
            <li key={item.id} className="mb-3 ps-3 border-start border-2 cb-border">
              <p className="mb-1">{item.claim}</p>
              <p className="small mb-1">
                <i className={`bi ${STRENGTH_ICON[key]} me-1`} aria-hidden="true" />
                {t(`report.strength.${key}`)}
              </p>
              {item.quote && (
                <blockquote className="small fst-italic mb-1">
                  <span className="visually-hidden">{t('report.dimensions.quote')}: </span>“
                  {item.quote}”
                </blockquote>
              )}
              <p className="small cb-text-secondary mb-0">
                {t('report.dimensions.question', { question: item.question })}
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function DimensionRow({ dimension }: { dimension: ReportDimension }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  const score = dimension.score;
  return (
    <li className="py-3 border-bottom cb-border">
      <h3 className="h6 mb-1">
        <button
          type="button"
          className="btn btn-link p-0 text-start text-decoration-none d-flex align-items-start gap-2 w-100"
          aria-expanded={open}
          aria-controls={`${id}-details`}
          onClick={() => setOpen((v) => !v)}
        >
          <i
            className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'} mt-1`}
            aria-hidden="true"
          />
          <span className="flex-grow-1">{dimension.name}</span>
          <span className="text-body fw-semibold text-nowrap">{scoreText(t, score)}</span>
        </button>
      </h3>
      <div className="ms-4">
        <div className="progress mb-1" style={{ height: '0.6rem' }} aria-hidden="true">
          {score !== null && <div className="progress-bar" style={{ width: `${score}%` }} />}
        </div>
        <p className="small cb-text-secondary mb-0">
          {t('report.dimensions.weight', { weight: dimension.weight })}
        </p>
        <div id={`${id}-details`} hidden={!open} className="mt-2">
          {dimension.fallback && (
            <p className="small alert alert-light border cb-border py-2 mb-2">
              <i className="bi bi-info-circle me-1" aria-hidden="true" />
              {t('report.dimensions.fallback')}
            </p>
          )}
          <p className="mb-0">{dimension.rationale ?? t('report.dimensions.noRationale')}</p>
          <EvidenceList dimension={dimension} />
        </div>
      </div>
    </li>
  );
}

function DimensionTable({ dimensions }: { dimensions: ReportDimension[] }) {
  const { t } = useTranslation();
  return (
    <div className="table-responsive">
      <table className="table align-middle mb-0">
        <caption className="visually-hidden">{t('report.dimensions.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('report.dimensions.skill')}</th>
            <th scope="col">{t('report.dimensions.weightColumn')}</th>
            <th scope="col">{t('report.dimensions.scoreColumn')}</th>
            <th scope="col">{t('report.dimensions.evidenceColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {dimensions.map((d) => (
            <tr key={d.key}>
              <th scope="row" className="fw-normal">
                {d.name}
              </th>
              <td>{t('report.percent', { value: d.weight })}</td>
              <td>{scoreText(t, d.score)}</td>
              <td>{d.evidence.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Screen 23 §3: skills sorted by score, as expandable bars or an accessible table. */
export function DimensionBars({ dimensions }: { dimensions: readonly ReportDimension[] }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const sorted = sortDimensions(dimensions);
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="dimensions-title">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <h2 id="dimensions-title" className="h5 mb-0">
          {t('report.dimensions.title')}
        </h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          <i className={`bi ${asTable ? 'bi-bar-chart' : 'bi-table'} me-1`} aria-hidden="true" />
          {t('report.dimensions.showTable')}
        </button>
      </div>
      <p className="small cb-text-secondary">{t('report.dimensions.hint')}</p>
      {sorted.length === 0 ? (
        <p className="cb-text-secondary mb-0">{t('report.dimensions.none')}</p>
      ) : asTable ? (
        <DimensionTable dimensions={sorted} />
      ) : (
        <ul className="list-unstyled mb-0">
          {sorted.map((d) => (
            <DimensionRow key={d.key} dimension={d} />
          ))}
        </ul>
      )}
    </section>
  );
}
