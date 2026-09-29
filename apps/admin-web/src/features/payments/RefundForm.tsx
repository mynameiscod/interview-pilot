import type {
  AdminPurchase,
  AdminRefundResult,
  RefundBody,
  RefundPreview,
} from '@cbi/shared-types';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatMoney, paiseToRupees, paymentsError, requiredInt, rupeesToPaise } from './format';
import { useRefundPreview } from './queries';
import { FieldError } from './shared';

type Body = Omit<RefundBody, 'acknowledgeUsedCredits'> & { acknowledgeUsedCredits: boolean };

/**
 * Refunds all or part of a purchase. The form opens with what the refund
 * involves (credits used, unused, already refunded) and suggests the amount
 * paid prorated to the unused credits; refunding money for used credits
 * needs an explicit confirmation.
 */
export function RefundForm({
  purchase,
  onDone,
  onCancel,
}: {
  purchase: AdminPurchase;
  onDone: (result: AdminRefundResult) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const preview = useRefundPreview(purchase.id, true);
  if (preview.isPending) {
    return (
      <div className="p-3 cb-surface-muted rounded-2">
        <p className="small cb-text-secondary mb-0">{t('payments.refund.loading')}</p>
        <LoadingRow />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <div className="p-3 cb-surface-muted rounded-2">
        <ErrorAlert error={paymentsError(t, preview.error)} />
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          {t('ai.cancel')}
        </button>
      </div>
    );
  }
  return (
    <RefundFields preview={preview.data} purchase={purchase} onDone={onDone} onCancel={onCancel} />
  );
}

function RefundFields({
  preview,
  purchase,
  onDone,
  onCancel,
}: {
  preview: RefundPreview;
  purchase: AdminPurchase;
  onDone: (result: AdminRefundResult) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const money = (minor: number) => formatMoney(minor, preview.currency);
  const initial = preview.suggestedMinor > 0 ? preview.suggestedMinor : preview.refundableMinor;
  const [amount, setAmount] = useState(paiseToRupees(initial));
  const [withdraw, setWithdraw] = useState(String(preview.creditsUnused));
  const [acknowledgedUsed, setAcknowledgedUsed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [invalid, setInvalid] = useState<{ amount?: boolean; withdraw?: boolean }>({});
  const [error, setError] = useState<string | null>(null);

  const amountMinor = rupeesToPaise(amount);
  const amountOk = amountMinor >= 1 && amountMinor <= preview.refundableMinor;
  const full = amountOk && amountMinor === preview.refundableMinor;
  const withdrawable = preview.creditsUnused + preview.creditsExpired;
  const withdrawCount = requiredInt(withdraw);
  const withdrawOk = full || (withdrawCount >= 0 && withdrawCount <= withdrawable);
  const usedCredits = preview.creditsUsed > 0;
  const total = money(amountOk ? amountMinor : preview.refundableMinor);

  const refund = useMutation({
    mutationFn: (body: Body) =>
      manager.api.post<AdminRefundResult>(`/admin/purchases/${purchase.id}/refund`, body),
    onSuccess: onDone,
    onError: (err) => setError(paymentsError(t, err)),
  });

  const submit = (reason: string) => {
    setError(null);
    setInvalid({ amount: !amountOk, withdraw: !withdrawOk });
    if (!amountOk || !withdrawOk) return;
    refund.mutate({
      reason,
      amountMinor,
      ...(full ? {} : { withdrawCredits: withdrawCount }),
      acknowledgeUsedCredits: usedCredits && acknowledgedUsed,
    });
  };

  return (
    <ReasonForm
      submitLabel={t('payments.refund.confirm', { total })}
      danger
      pending={refund.isPending}
      disabled={!confirmed || (usedCredits && !acknowledgedUsed)}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="fw-semibold mb-2">{t('payments.refund.title')}</p>
      <dl className="row small mb-2">
        <dt className="col-sm-5">{t('payments.refund.paid')}</dt>
        <dd className="col-sm-7">{money(preview.capturedMinor)}</dd>
        <dt className="col-sm-5">{t('payments.refund.alreadyRefunded')}</dt>
        <dd className="col-sm-7">{money(preview.refundedMinor)}</dd>
        <dt className="col-sm-5">{t('payments.refund.left')}</dt>
        <dd className="col-sm-7 fw-semibold">{money(preview.refundableMinor)}</dd>
        <dt className="col-sm-5">{t('payments.refund.credits')}</dt>
        <dd className="col-sm-7 mb-0">
          {t('payments.refund.creditsLine', {
            granted: preview.creditsGranted,
            used: preview.creditsUsed,
            unused: preview.creditsUnused,
            expired: preview.creditsExpired,
            withdrawn: preview.creditsWithdrawn,
          })}
        </dd>
      </dl>
      {usedCredits && (
        <div className="alert alert-warning py-2 small">
          <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
          {t('payments.refund.usedWarning', { count: preview.creditsUsed })}
          <div className="form-check mt-2 mb-0">
            <input
              id={`${id}-used`}
              type="checkbox"
              className="form-check-input"
              checked={acknowledgedUsed}
              onChange={(e) => setAcknowledgedUsed(e.target.checked)}
            />
            <label htmlFor={`${id}-used`} className="form-check-label">
              {t('payments.refund.acknowledgeUsed')}
            </label>
          </div>
        </div>
      )}
      <div className="row g-2 mb-2">
        <div className="col-md-6">
          <label htmlFor={`${id}-amount`} className="form-label small">
            {t('payments.refund.amount')}
          </label>
          <div className="input-group input-group-sm">
            <span className="input-group-text">₹</span>
            <input
              id={`${id}-amount`}
              type="text"
              inputMode="decimal"
              className={`form-control ${invalid.amount ? 'is-invalid' : ''}`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={invalid.amount || undefined}
              aria-describedby={`${id}-amount-hint${invalid.amount ? ` ${id}-amount-error` : ''}`}
            />
          </div>
          <FieldError
            id={`${id}-amount-error`}
            message={
              invalid.amount
                ? t('payments.refund.amountError', { max: money(preview.refundableMinor) })
                : undefined
            }
          />
          <div id={`${id}-amount-hint`} className="form-text">
            {t('payments.refund.amountHint', {
              suggested: money(preview.suggestedMinor),
              max: money(preview.refundableMinor),
            })}
          </div>
          <div className="d-flex flex-wrap gap-2 mt-1">
            <button
              type="button"
              className="btn btn-sm btn-link p-0"
              onClick={() => setAmount(paiseToRupees(preview.suggestedMinor))}
            >
              {t('payments.refund.useSuggested')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-link p-0"
              onClick={() => setAmount(paiseToRupees(preview.refundableMinor))}
            >
              {t('payments.refund.useFull')}
            </button>
          </div>
        </div>
        <div className="col-md-6">
          {full ? (
            <p className="small cb-text-secondary mt-md-4 mb-0">
              {t('payments.refund.withdrawAll', { count: withdrawable })}
            </p>
          ) : (
            <>
              <label htmlFor={`${id}-withdraw`} className="form-label small">
                {t('payments.refund.withdraw')}
              </label>
              <input
                id={`${id}-withdraw`}
                type="text"
                inputMode="numeric"
                className={`form-control form-control-sm ${invalid.withdraw ? 'is-invalid' : ''}`}
                value={withdraw}
                onChange={(e) => setWithdraw(e.target.value)}
                aria-invalid={invalid.withdraw || undefined}
                aria-describedby={`${id}-withdraw-hint${invalid.withdraw ? ` ${id}-withdraw-error` : ''}`}
              />
              <FieldError
                id={`${id}-withdraw-error`}
                message={
                  invalid.withdraw
                    ? t('payments.refund.withdrawError', { count: withdrawable })
                    : undefined
                }
              />
              <div id={`${id}-withdraw-hint`} className="form-text">
                {t('payments.refund.withdrawHint', { count: withdrawable })}
              </div>
            </>
          )}
        </div>
      </div>
      <ul className="small">
        <li>{t('payments.refund.explainMoney', { total })}</li>
        <li>{t('payments.refund.explainUsed')}</li>
      </ul>
      <div className="form-check mb-2">
        <input
          id={`${id}-confirm`}
          type="checkbox"
          className="form-check-input"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <label htmlFor={`${id}-confirm`} className="form-check-label">
          {t('payments.refund.acknowledge')}
        </label>
      </div>
    </ReasonForm>
  );
}
