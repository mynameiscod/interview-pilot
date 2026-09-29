import type { AdminCreditAccount, CreditAdjustmentBody } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { optionalInt, requiredInt } from './format';
import { paymentsKeys, useCreditAccount } from './queries';
import { FieldError } from './shared';

/** Adjustment conflicts (not enough usable credits) carry a specific server message. */
function creditsError(t: Parameters<typeof consoleError>[0], err: unknown): string {
  if (err instanceof ApiClientError && err.code === 'INSUFFICIENT_CREDITS') return err.message;
  return consoleError(t, err);
}

function Account({ account }: { account: AdminCreditAccount }) {
  const { t, i18n } = useTranslation();
  const date = (value: string | null) =>
    value ? formatDateTime(value, i18n.language) : t('payments.credits.never');
  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby="credit-account-heading"
    >
      <h2 id="credit-account-heading" className="h6">
        {t('payments.credits.account')}
      </h2>
      <p className="mb-2">
        {account.userEmail ?? '—'}
        <span className="d-block small font-monospace cb-text-secondary">{account.userId}</span>
      </p>
      <dl className="row small">
        <dt className="col-sm-5">{t('payments.credits.available')}</dt>
        <dd className="col-sm-7 fw-semibold">{account.balance.available}</dd>
        <dt className="col-sm-5">{t('payments.credits.reserved')}</dt>
        <dd className="col-sm-7">{account.balance.reserved}</dd>
      </dl>
      <h3 className="h6">{t('payments.credits.lots')}</h3>
      {account.balance.lots.length === 0 ? (
        <p className="small cb-text-secondary">{t('payments.credits.noLots')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm small align-middle">
            <thead>
              <tr>
                <th scope="col">{t('payments.credits.entry')}</th>
                <th scope="col" className="text-end">
                  {t('payments.credits.remaining')}
                </th>
                <th scope="col">{t('payments.credits.expires')}</th>
              </tr>
            </thead>
            <tbody>
              {account.balance.lots.map((lot, i) => (
                <tr key={i}>
                  <td>{t(`payments.credits.lotSource.${lot.source}`)}</td>
                  <td className="text-end">{lot.remaining}</td>
                  <td>{date(lot.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="h6">{t('payments.credits.ledger')}</h3>
      {account.ledger.length === 0 ? (
        <p className="small cb-text-secondary mb-0">{t('payments.credits.noLedger')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm small align-middle mb-0">
            <caption className="visually-hidden">{t('payments.credits.ledger')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('payments.credits.when')}</th>
                <th scope="col">{t('payments.credits.entry')}</th>
                <th scope="col" className="text-end">
                  {t('payments.credits.change')}
                </th>
                <th scope="col">{t('payments.credits.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {account.ledger.map((e) => (
                <tr key={e.id}>
                  <td className="text-nowrap">{formatDateTime(e.createdAt, i18n.language)}</td>
                  <td>{t(`payments.credits.entryType.${e.type}`)}</td>
                  <td className="text-end">{e.amount > 0 ? `+${e.amount}` : e.amount}</td>
                  <td>{e.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdjustForm({ account, lookup }: { account: AdminCreditAccount; lookup: string }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'grant' | 'deduct'>('grant');
  const [count, setCount] = useState('1');
  const [expires, setExpires] = useState('');
  const [invalid, setInvalid] = useState<{ count?: boolean; expires?: boolean }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The form remounts after each success so the reason field starts empty.
  const [round, setRound] = useState(0);

  const n = requiredInt(count);
  const countOk = n >= 1 && n <= 500;
  const days = optionalInt(expires);
  const expiresOk = direction === 'deduct' || days === null || (days >= 1 && days <= 3650);

  const adjust = useMutation({
    mutationFn: (body: CreditAdjustmentBody) =>
      manager.api.post<AdminCreditAccount>('/admin/credits/adjustments', body),
    onSuccess: (next, body) => {
      queryClient.setQueryData(paymentsKeys.creditAccount(lookup), next);
      setError(null);
      setNotice(
        t(body.delta > 0 ? 'payments.credits.granted' : 'payments.credits.deducted', {
          count: Math.abs(body.delta),
        }),
      );
      setRound((r) => r + 1);
    },
    onError: (err) => setError(creditsError(t, err)),
  });

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('payments.credits.adjust')}
      </h2>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      <ReasonForm
        key={round}
        submitLabel={t(
          direction === 'grant' ? 'payments.credits.submitGrant' : 'payments.credits.submitDeduct',
          { count: countOk ? n : 0 },
        )}
        danger={direction === 'deduct'}
        pending={adjust.isPending}
        error={error}
        onSubmit={(reason) => {
          setNotice(null);
          setInvalid({ count: !countOk, expires: !expiresOk });
          if (!countOk || !expiresOk) return;
          adjust.mutate({
            userId: account.userId,
            delta: direction === 'grant' ? n : -n,
            reason,
            expiresInDays: direction === 'grant' ? days : null,
          });
        }}
        onCancel={() => {
          setCount('1');
          setExpires('');
          setInvalid({});
          setError(null);
          setRound((r) => r + 1);
        }}
      >
        <fieldset className="mb-2">
          <legend className="form-label small">{t('payments.credits.direction')}</legend>
          {(['grant', 'deduct'] as const).map((d) => (
            <div className="form-check form-check-inline" key={d}>
              <input
                id={`${id}-${d}`}
                type="radio"
                name={`${id}-direction`}
                className="form-check-input"
                checked={direction === d}
                onChange={() => setDirection(d)}
              />
              <label htmlFor={`${id}-${d}`} className="form-check-label">
                {t(`payments.credits.${d}`)}
              </label>
            </div>
          ))}
        </fieldset>
        <div className="row g-2 mb-2">
          <div className="col-sm-4">
            <label htmlFor={`${id}-count`} className="form-label small">
              {t('payments.credits.count')}
            </label>
            <input
              id={`${id}-count`}
              type="text"
              inputMode="numeric"
              className={`form-control form-control-sm ${invalid.count ? 'is-invalid' : ''}`}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              aria-invalid={invalid.count || undefined}
              aria-describedby={invalid.count ? `${id}-count-error` : undefined}
            />
            <FieldError
              id={`${id}-count-error`}
              message={invalid.count ? t('payments.credits.countError') : undefined}
            />
          </div>
          {direction === 'grant' ? (
            <div className="col-sm-8">
              <label htmlFor={`${id}-expires`} className="form-label small">
                {t('payments.credits.expiresInDays')}
              </label>
              <input
                id={`${id}-expires`}
                type="text"
                inputMode="numeric"
                className={`form-control form-control-sm ${invalid.expires ? 'is-invalid' : ''}`}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                aria-invalid={invalid.expires || undefined}
                aria-describedby={`${id}-expires-hint${invalid.expires ? ` ${id}-expires-error` : ''}`}
              />
              <FieldError
                id={`${id}-expires-error`}
                message={invalid.expires ? t('payments.credits.expiresInDaysError') : undefined}
              />
              <div id={`${id}-expires-hint`} className="form-text">
                {t('payments.credits.expiresInDaysHint')}
              </div>
            </div>
          ) : (
            <p className="col-sm-8 small cb-text-secondary mt-sm-4 mb-0">
              {t('payments.credits.deductHint')}
            </p>
          )}
        </div>
      </ReasonForm>
    </section>
  );
}

/**
 * A candidate's credits by email or user id, with manual grants and
 * deductions for admins allowed to adjust credits (reached from Purchases).
 */
export function CreditsPage() {
  const { t } = useTranslation();
  const id = useId();
  const canAdjust = useCan('credits.adjust');
  const [params, setParams] = useSearchParams();
  const user = params.get('user')?.trim() ?? '';
  const [input, setInput] = useState(user);
  const account = useCreditAccount(user);

  return (
    <>
      <h1 className="h3 mb-2">{t('payments.credits.title')}</h1>
      <p className="cb-text-secondary">{t('payments.credits.subtitle')}</p>
      <form
        role="search"
        aria-label={t('payments.credits.lookupLabel')}
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          if (input.trim()) next.set('user', input.trim());
          setParams(next);
        }}
      >
        <div className="col-sm-8 col-lg-6">
          <label htmlFor={`${id}-user`} className="form-label small">
            {t('payments.credits.user')}
          </label>
          <input
            id={`${id}-user`}
            type="search"
            className="form-control form-control-sm"
            maxLength={254}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <div className="col-sm-4 col-lg-3">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('payments.credits.find')}
          </button>
        </div>
      </form>
      {account.isFetching && !account.data && <LoadingRow />}
      {account.isError && <ErrorAlert error={consoleError(t, account.error)} />}
      {account.data && (
        <div className="row g-3">
          <div className="col-lg-7">
            <Account account={account.data} />
          </div>
          <div className="col-lg-5">
            {canAdjust ? (
              <AdjustForm account={account.data} lookup={user} />
            ) : (
              <p className="small cb-text-secondary">
                <i className="bi bi-lock me-1" aria-hidden="true" />
                {t('payments.credits.readOnly')}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
