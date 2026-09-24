import type { PublicPlan } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatMoney, validityText } from './payment-format';
import { usePlans } from './payments-api';

function PlanCard({ plan }: { plan: PublicPlan }) {
  const { t, i18n } = useTranslation();
  const free = plan.priceMinor === 0;
  const titleId = `plan-${plan.code}`;

  return (
    <li className="col-md-6 col-lg-4">
      <article
        className={`h-100 p-4 border rounded-3 bg-white d-flex flex-column ${
          plan.featured ? 'border-primary border-2' : 'cb-border'
        }`}
        aria-labelledby={titleId}
      >
        <div className="d-flex align-items-start justify-content-between gap-2">
          <h2 id={titleId} className="h5 mb-1">
            {plan.name}
          </h2>
          {plan.featured && <span className="badge text-bg-primary">{t('pricing.featured')}</span>}
        </div>
        {plan.description && <p className="small cb-text-secondary">{plan.description}</p>}
        <p className="fs-3 fw-semibold mb-0">
          {free
            ? t('pricing.free')
            : formatMoney(i18n.resolvedLanguage, plan.priceMinor, plan.currency)}
        </p>
        <p className="mb-1">{t('pricing.credits', { count: plan.credits })}</p>
        <p className="small cb-text-secondary">{validityText(t, plan.validityDays)}</p>
        {plan.features.length > 0 && (
          <ul className="list-unstyled small">
            {plan.features.map((feature) => (
              <li key={feature} className="d-flex gap-2 mb-1">
                <i className="bi bi-check2 text-secondary" aria-hidden="true" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto pt-2">
          {free ? (
            <p className="small fw-semibold mb-0">{t('pricing.includedFree')}</p>
          ) : (
            <Link
              to={`/app/checkout/${encodeURIComponent(plan.code)}`}
              className={`btn w-100 ${plan.featured ? 'btn-primary' : 'btn-outline-primary'}`}
              aria-label={t('pricing.buyNamed', { name: plan.name })}
            >
              {t('pricing.buy')}
            </Link>
          )}
        </div>
      </article>
    </li>
  );
}

/** Public pricing: every active plan, including the free credit each account gets. */
export function PricingPage() {
  const { t } = useTranslation();
  const plans = usePlans();

  return (
    <div className="container py-5">
      <h1 className="h3">{t('pricing.title')}</h1>
      <p className="cb-text-secondary">{t('pricing.subtitle')}</p>

      {plans.isPending && <p className="cb-text-secondary">{t('common.loading')}</p>}
      {plans.isError && (
        <div className="alert alert-danger" role="alert">
          {t('pricing.error')}
        </div>
      )}
      {plans.data && (
        <ul className="row list-unstyled g-4 mt-1 mb-0">
          {plans.data.map((plan) => (
            <PlanCard key={plan.code} plan={plan} />
          ))}
        </ul>
      )}
      <p className="small cb-text-secondary mt-4 mb-0">{t('pricing.note')}</p>
    </div>
  );
}
