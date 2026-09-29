import { DELIVERY_TARGETS, type ReportDelivery } from '@cbi/shared-types';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const T = DELIVERY_TARGETS;
const per100 = (count: number, words: number) =>
  words > 0 ? Math.round((count * 1000) / words) / 10 : 0;

function Metric({
  label,
  value,
  target,
  onTarget,
  detail,
}: {
  label: string;
  value: string;
  target: string;
  /** Null when there is nothing to judge (not measured). */
  onTarget: boolean | null;
  detail?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="col-sm-6">
      <div className="h-100 p-3 border cb-border rounded-3">
        <p className="small cb-text-secondary mb-1">{label}</p>
        <p className="fs-5 fw-semibold mb-1">{value}</p>
        <p className="small mb-1">{target}</p>
        {onTarget !== null && (
          <p className="small mb-0">
            <i
              className={`bi ${onTarget ? 'bi-check-circle text-success' : 'bi-arrow-repeat text-warning'} me-1`}
              aria-hidden="true"
            />
            {onTarget ? t('report.delivery.onTarget') : t('report.delivery.offTarget')}
          </p>
        )}
        {detail}
      </div>
    </div>
  );
}

/**
 * The Delivery tab (spoken answers only): pace, filler words, long pauses and
 * hedging against targets, with tips. Coaching only; it says so, because
 * pace and fillers vary with accent, language and speech differences.
 */
export function DeliverySection({ delivery }: { delivery: ReportDelivery }) {
  const { t, i18n } = useTranslation();
  const s = delivery.summary;
  const number = (n: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(n);
  const minutes = s.durationSec / 60;
  const pausesPerMinute = s.longPauses !== null && minutes > 0 ? s.longPauses / minutes : null;
  const hedgeRate = per100(s.hedgeCount, s.wordCount);
  const list = (items: readonly { text: string; count: number }[]) =>
    items.map((i) => `“${i.text}” × ${number(i.count)}`).join(', ');

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="delivery-title">
      <h2 id="delivery-title" className="h5">
        {t('report.delivery.title')}
      </h2>
      <p className="cb-text-secondary">{t('report.delivery.intro')}</p>
      <div className="alert alert-info d-flex gap-2" role="note">
        <i className="bi bi-shield-check" aria-hidden="true" />
        <div>{t('report.delivery.fairness')}</div>
      </div>

      <div className="row g-3 mb-4">
        <Metric
          label={t('report.delivery.pace')}
          value={
            s.wpm === null
              ? t('report.delivery.paceNone')
              : t('report.delivery.paceValue', { wpm: number(s.wpm) })
          }
          target={t('report.delivery.paceTarget', { min: T.wpm.min, max: T.wpm.max })}
          onTarget={s.wpm === null ? null : s.wpm >= T.wpm.min && s.wpm <= T.wpm.max}
        />
        <Metric
          label={t('report.delivery.fillers')}
          value={t('report.delivery.fillersValue', {
            total: number(s.fillerCount),
            rate: number(s.fillerRate),
          })}
          target={t('report.delivery.fillersTarget', { max: T.maxFillersPer100 })}
          onTarget={s.fillerRate <= T.maxFillersPer100}
          detail={
            s.topFillers.length > 0 && (
              <p className="small cb-text-secondary mb-0 mt-1">
                {t('report.delivery.common', { words: list(s.topFillers) })}
              </p>
            )
          }
        />
        <Metric
          label={t('report.delivery.pauses')}
          value={s.longPauses === null ? t('report.delivery.notMeasured') : number(s.longPauses)}
          target={t('report.delivery.pausesTarget', { max: T.maxLongPausesPerMinute })}
          onTarget={pausesPerMinute === null ? null : pausesPerMinute <= T.maxLongPausesPerMinute}
        />
        <Metric
          label={t('report.delivery.hedges')}
          value={number(s.hedgeCount)}
          target={t('report.delivery.hedgesTarget', { max: T.maxHedgesPer100 })}
          onTarget={hedgeRate <= T.maxHedgesPer100}
          detail={
            s.topHedges.length > 0 && (
              <p className="small cb-text-secondary mb-0 mt-1">
                {t('report.delivery.common', { words: list(s.topHedges) })}
              </p>
            )
          }
        />
      </div>

      <h3 className="h6">{t('report.delivery.tipsTitle')}</h3>
      {delivery.tips.length === 0 ? (
        <p>{t('report.delivery.noTips')}</p>
      ) : (
        <ul className="list-unstyled">
          {delivery.tips.map((tip) => (
            <li key={tip} className="d-flex gap-2 mb-2">
              <i className="bi bi-lightbulb mt-1" aria-hidden="true" />
              <span>{t(`report.delivery.tips.${tip}`)}</span>
            </li>
          ))}
        </ul>
      )}

      {delivery.answers.length > 0 && (
        <>
          <h3 className="h6 mt-4" id="delivery-answers-title">
            {t('report.delivery.perAnswer')}
          </h3>
          <div
            className="table-responsive"
            tabIndex={0}
            role="group"
            aria-labelledby="delivery-answers-title"
          >
            <table className="table table-sm mb-0">
              <caption className="visually-hidden">{t('report.delivery.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('report.delivery.question')}</th>
                  <th scope="col">{t('report.delivery.length')}</th>
                  <th scope="col">{t('report.delivery.pace')}</th>
                  <th scope="col">{t('report.delivery.fillers')}</th>
                  <th scope="col">{t('report.delivery.pausesShort')}</th>
                </tr>
              </thead>
              <tbody>
                {delivery.answers.map((a) => (
                  <tr key={a.questionId}>
                    <th scope="row" className="fw-normal text-nowrap">
                      {t('report.questions.question', { n: a.seq })}
                    </th>
                    <td className="text-nowrap">
                      {t('report.delivery.seconds', {
                        value: number(Math.round(a.metrics.durationSec)),
                      })}
                    </td>
                    <td>{a.metrics.wpm === null ? '–' : number(a.metrics.wpm)}</td>
                    <td>{number(a.metrics.fillerCount)}</td>
                    <td>{a.metrics.longPauses === null ? '–' : number(a.metrics.longPauses)}</td>
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
