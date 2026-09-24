import { useTranslation } from 'react-i18next';
import { StepActions } from './StepActions';

export function StartStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const items = ['resume', 'jd', 'target'] as const;
  return (
    <>
      <p>{t('wizard.start.intro')}</p>
      <h3 className="h6 mt-4">{t('wizard.start.needTitle')}</h3>
      <ul className="list-unstyled">
        {items.map((item) => (
          <li key={item} className="d-flex gap-2 mb-2">
            <i className="bi bi-check2-circle text-secondary" aria-hidden="true" />
            <span>
              <span className="fw-semibold">{t(`wizard.start.${item}Title`)}</span>{' '}
              <span className="cb-text-secondary">{t(`wizard.start.${item}Body`)}</span>
            </span>
          </li>
        ))}
      </ul>
      <h3 className="h6 mt-4">{t('wizard.start.nextTitle')}</h3>
      <p className="cb-text-secondary">{t('wizard.start.nextBody')}</p>
      <div className="p-3 rounded-3 cb-surface-muted d-flex gap-2">
        <i className="bi bi-shield-lock text-primary" aria-hidden="true" />
        <p className="small mb-0">{t('wizard.start.privacy')}</p>
      </div>
      <StepActions nextLabel={t('wizard.start.begin')} onNext={onNext} />
    </>
  );
}
