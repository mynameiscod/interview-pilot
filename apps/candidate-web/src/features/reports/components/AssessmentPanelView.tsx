import type { AssessmentPanel } from '@cbi/shared-types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A panel scored beside the role's dimensions (system design, or working
 * with the AI assistant). Scores are shown as numbers and words, never as
 * colour alone, and the panel says it is not part of the overall score.
 */
export function AssessmentPanelView({
  kind,
  panel,
}: {
  kind: 'systemDesign' | 'aiCollaboration';
  panel: AssessmentPanel;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5">
        {t(`report.panels.${kind}.title`)}
      </h2>
      <p className="small cb-text-secondary">
        {t(`report.panels.${kind}.intro`)} {t('report.panels.separate')}
      </p>
      {panel.subjects.length > 0 && (
        <p className="small mb-2">
          <span className="fw-semibold">{t('report.panels.subjects')}</span>{' '}
          {panel.subjects.join(', ')}
        </p>
      )}
      {panel.fallback ? (
        <p className="mb-0">{t('report.panels.unavailable')}</p>
      ) : (
        <>
          <p className="fw-semibold mb-1">
            {panel.score === null
              ? t('report.panels.notScored')
              : t('report.panels.score', { score: panel.score })}
          </p>
          {panel.summary && <p>{panel.summary}</p>}
          <ul className="list-unstyled mb-0">
            {panel.dimensions.map((d) => (
              <li key={d.key} className="py-2 border-top cb-border">
                <p className="fw-semibold mb-1">
                  {t(`report.panels.dimensions.${d.key}`)}
                  {': '}
                  {d.score === null
                    ? t('report.panels.notAssessed')
                    : t('report.panels.score', { score: d.score })}
                </p>
                {d.rationale && <p className="small mb-1">{d.rationale}</p>}
                {d.evidence.length > 0 && (
                  <ul className="small cb-text-secondary mb-0">
                    {d.evidence.map((e, i) => (
                      <li key={i}>
                        <span className="visually-hidden">
                          {t(`report.panels.sources.${e.source}`)}:{' '}
                        </span>
                        “{e.quote}”
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
