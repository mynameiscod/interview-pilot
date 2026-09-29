import type { PeerBenchmark } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

/** "Better than X% of candidates practising for <role>" (shown only with 30+ other candidates). */
export function BenchmarkCard({ benchmark }: { benchmark: PeerBenchmark }) {
  const { t, i18n } = useTranslation();
  const number = (n: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(n);
  const headline =
    benchmark.basis === 'ROLE' && benchmark.roleTitle
      ? t('report.benchmark.role', { percentile: benchmark.percentile, role: benchmark.roleTitle })
      : t('report.benchmark.family', {
          percentile: benchmark.percentile,
          family: t(`report.benchmark.families.${benchmark.family ?? 'OTHER'}`),
        });
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="benchmark-title">
      <h2 id="benchmark-title" className="h5">
        {t('report.benchmark.title')}
      </h2>
      <p className="fs-5 fw-semibold mb-2">
        <i className="bi bi-people me-2" aria-hidden="true" />
        {headline}
      </p>
      <div className="progress mb-2" style={{ height: '0.6rem' }} aria-hidden="true">
        <div className="progress-bar" style={{ width: `${benchmark.percentile}%` }} />
      </div>
      <p className="small cb-text-secondary mb-0">
        {t('report.benchmark.note', {
          total: number(benchmark.sampleSize),
          days: benchmark.windowDays,
        })}
      </p>
    </section>
  );
}
