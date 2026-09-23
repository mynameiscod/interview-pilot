import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function ErrorAlert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-danger py-2" role="alert">
      {error}
    </div>
  );
}

export function LoadingRow() {
  const { t } = useTranslation();
  return (
    <div className="p-4" role="status">
      {t('common.loading')}
    </div>
  );
}

/**
 * An inline confirmation that collects the audit-log reason every AI
 * configuration change requires. Children render extra fields above it.
 */
export function ReasonForm({
  submitLabel,
  danger,
  pending,
  error,
  disabled,
  onSubmit,
  onCancel,
  children,
}: {
  submitLabel: string;
  danger?: boolean;
  pending: boolean;
  error: string | null;
  disabled?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <form
      className="p-3 cb-surface-muted rounded-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
      }}
    >
      {children}
      <label htmlFor={`${id}-reason`} className="form-label">
        {t('ai.reason')}
      </label>
      <input
        id={`${id}-reason`}
        className="form-control mb-2"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        minLength={3}
        maxLength={300}
        required
      />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button
          type="submit"
          className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={pending || disabled || reason.trim().length < 3}
        >
          {submitLabel}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}
