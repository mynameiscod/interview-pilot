import { UiLocale } from '@cbi/shared-types';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const current = UiLocale.safeParse(i18n.resolvedLanguage);

  return (
    <div className="d-flex align-items-center gap-2">
      <label htmlFor={id} className="form-label mb-0 small cb-text-secondary">
        <i className="bi bi-translate" aria-hidden="true" />
        <span className="visually-hidden">{t('language.label')}</span>
      </label>
      <select
        id={id}
        className="form-select form-select-sm"
        value={current.success ? current.data : 'en'}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
      >
        {UiLocale.options.map((lng) => (
          <option key={lng} value={lng}>
            {t(`language.${lng}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
