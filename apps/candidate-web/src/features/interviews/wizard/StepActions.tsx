import { useTranslation } from 'react-i18next';

interface Props {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextPending?: boolean;
  pendingLabel?: string;
  /** Optional secondary action such as "Skip this step". */
  skipLabel?: string;
  onSkip?: () => void;
}

/** Back / skip / next buttons shared by the wizard steps. */
export function StepActions({
  onBack,
  onNext,
  nextLabel,
  nextPending,
  pendingLabel,
  skipLabel,
  onSkip,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="d-flex flex-wrap align-items-center gap-2 mt-4 pt-3 border-top cb-border">
      {onBack && (
        <button type="button" className="btn btn-outline-secondary" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          {t('wizard.back')}
        </button>
      )}
      <div className="ms-auto d-flex flex-wrap gap-2">
        {onSkip && skipLabel && (
          <button type="button" className="btn btn-link" onClick={onSkip}>
            {skipLabel}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={nextPending}>
          {nextPending ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
              {pendingLabel ?? t('common.loading')}
            </>
          ) : (
            <>
              {nextLabel ?? t('wizard.continue')}
              <i className="bi bi-arrow-right ms-1" aria-hidden="true" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
