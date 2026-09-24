import { CODING_LANGUAGE_LABELS, type CodingReportItem } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

function outcome(t: ReturnType<typeof useTranslation>['t'], item: CodingReportItem): string {
  if (!item.submitted) return t('report.coding.notSubmitted');
  if (item.judgeUnavailable || item.passed === null || item.total === null) {
    return t('report.coding.notRun');
  }
  return t('report.coding.passed', { passed: item.passed, total: item.total });
}

/** Coding problems: what was attempted and how many tests passed (neutral, no colours). */
export function CodingResults({ items }: { items: CodingReportItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="coding-title">
      <h2 id="coding-title" className="h5">
        {t('report.coding.title')}
      </h2>
      <ul className="list-unstyled mb-0">
        {items.map((item, index) => (
          <li
            key={index}
            className={`py-2 ${index < items.length - 1 ? 'border-bottom cb-border' : ''}`}
          >
            <p className="fw-semibold mb-1">
              <i className="bi bi-code-slash me-2" aria-hidden="true" />
              {item.title}
            </p>
            <p className="small cb-text-secondary mb-1">
              {t(`coding.difficulty.${item.difficulty}`)}
              {item.language && (
                <>
                  {' · '}
                  {t('report.coding.language', { language: CODING_LANGUAGE_LABELS[item.language] })}
                </>
              )}
            </p>
            <p className="mb-0">{outcome(t, item)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
