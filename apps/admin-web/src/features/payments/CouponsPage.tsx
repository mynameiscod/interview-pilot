import { CouponType, UpsertCouponBody, type CouponSummary } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime, validationIssues, type Issue } from '../library/format';
import { ActiveBadge, IssueList } from '../library/shared';
import {
  formatMoney,
  isoToLocalInput,
  issueFields,
  localInputToIso,
  optionalInt,
  paiseToRupees,
  paymentsError,
  requiredInt,
  rupeesToPaise,
} from './format';
import { paymentsKeys, useCoupons, usePlans } from './queries';
import { FieldError } from './shared';

type CouponFormValues = {
  code: string;
  type: CouponType;
  value: string;
  validFrom: string;
  validTo: string;
  maxUses: string;
  perUserLimit: string;
  planCodes: string[];
  active: boolean;
};
type CouponField = keyof CouponFormValues;

const FIELDS: CouponField[] = [
  'code',
  'type',
  'value',
  'validFrom',
  'validTo',
  'maxUses',
  'perUserLimit',
  'planCodes',
  'active',
];

const couponField = (path: string): CouponField | null => {
  const root = path.split('.')[0] as CouponField;
  return FIELDS.includes(root) ? root : null;
};

const toForm = (coupon: CouponSummary | null): CouponFormValues => ({
  code: coupon?.code ?? '',
  type: coupon?.type ?? 'PERCENT',
  value: coupon
    ? coupon.type === 'PERCENT'
      ? String(coupon.value)
      : paiseToRupees(coupon.value)
    : '',
  validFrom: isoToLocalInput(coupon?.validFrom ?? null),
  validTo: isoToLocalInput(coupon?.validTo ?? null),
  maxUses: coupon?.maxUses == null ? '' : String(coupon.maxUses),
  perUserLimit: String(coupon?.perUserLimit ?? 1),
  planCodes: coupon?.planCodes ?? [],
  active: coupon?.active ?? true,
});

/** PERCENT values are whole percents; FIXED values are typed in rupees and sent as paise. */
const toCouponBody = (values: CouponFormValues) => ({
  code: values.code,
  type: values.type,
  value: values.type === 'PERCENT' ? requiredInt(values.value) : rupeesToPaise(values.value),
  validFrom: localInputToIso(values.validFrom),
  validTo: localInputToIso(values.validTo),
  maxUses: optionalInt(values.maxUses),
  perUserLimit: requiredInt(values.perUserLimit),
  planCodes: values.planCodes,
  active: values.active,
});

const errorKey = (field: CouponField, values: CouponFormValues) =>
  field === 'value'
    ? `payments.coupons.errors.value${values.type === 'PERCENT' ? 'Percent' : 'Fixed'}`
    : `payments.coupons.errors.${field}`;

/** Validates with the shared UpsertCouponBody; messages are i18n keys per field. */
const couponResolver: Resolver<CouponFormValues> = async (values) => {
  const parsed = UpsertCouponBody.safeParse(toCouponBody(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<CouponFormValues> = {};
  for (const field of issueFields(parsed.error, couponField)) {
    errors[field] = { type: 'validation', message: errorKey(field, values) };
  }
  return { values: {}, errors };
};

function discountLabel(coupon: Pick<CouponSummary, 'type' | 'value'>) {
  return coupon.type === 'PERCENT' ? `${coupon.value}%` : formatMoney(coupon.value, 'INR');
}

function CouponEditor({
  coupon,
  onDone,
}: {
  coupon: CouponSummary | null;
  onDone: (saved: CouponSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const plans = usePlans();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<CouponFormValues>({ resolver: couponResolver, defaultValues: toForm(coupon) });
  const type = useWatch({ control, name: 'type' });
  const planCodes = useWatch({ control, name: 'planCodes' });
  const codeOptions = [
    ...new Set([...(plans.data ?? []).map((p) => p.code), ...(coupon?.planCodes ?? [])]),
  ];

  const errorId = (name: CouponField) => `${id}-${name}-error`;
  const fieldProps = (name: CouponField, hint = false) => ({
    id: `${id}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby':
      [errors[name] ? errorId(name) : '', hint ? `${id}-${name}-hint` : ''].join(' ').trim() ||
      undefined,
  });
  const invalidClass = (name: CouponField) => (errors[name] ? 'is-invalid' : '');
  const message = (name: CouponField) => {
    const key = errors[name]?.message;
    return key ? t(key) : undefined;
  };

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        setIssues([]);
        try {
          const body = UpsertCouponBody.parse(toCouponBody(values));
          const saved = coupon
            ? await manager.api.put<CouponSummary>(`/admin/coupons/${coupon.id}`, body)
            : await manager.api.post<CouponSummary>('/admin/coupons', body);
          await queryClient.invalidateQueries({ queryKey: paymentsKeys.coupons });
          onDone(saved);
        } catch (err) {
          if (err instanceof ApiClientError && err.code === 'CONFLICT') {
            setFieldError('code', { message: 'payments.coupons.errors.codeTaken' });
            return;
          }
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : paymentsError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {coupon
          ? t('payments.coupons.editTitle', { code: coupon.code })
          : t('payments.coupons.newTitle')}
      </h2>
      <div className="row g-2 mb-3">
        <div className="col-md-4">
          <label htmlFor={`${id}-code`} className="form-label small">
            {t('payments.coupons.code')}
          </label>
          <input
            className={`form-control form-control-sm font-monospace text-uppercase ${invalidClass('code')}`}
            spellCheck={false}
            readOnly={coupon !== null}
            {...fieldProps('code', true)}
            {...register('code')}
          />
          <FieldError id={errorId('code')} message={message('code')} />
          <div id={`${id}-code-hint`} className="form-text">
            {coupon ? t('payments.coupons.codeLocked') : t('payments.coupons.codeHint')}
          </div>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-type`} className="form-label small">
            {t('payments.coupons.type')}
          </label>
          <select
            className="form-select form-select-sm"
            {...fieldProps('type')}
            {...register('type')}
          >
            {CouponType.options.map((c) => (
              <option key={c} value={c}>
                {t(`payments.coupons.types.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-value`} className="form-label small">
            {type === 'PERCENT'
              ? t('payments.coupons.valuePercent')
              : t('payments.coupons.valueRupees')}
          </label>
          <div className="input-group input-group-sm">
            {type === 'FIXED' && <span className="input-group-text">₹</span>}
            <input
              inputMode={type === 'PERCENT' ? 'numeric' : 'decimal'}
              className={`form-control ${invalidClass('value')}`}
              {...fieldProps('value')}
              {...register('value')}
            />
            {type === 'PERCENT' && <span className="input-group-text">%</span>}
          </div>
          <FieldError id={errorId('value')} message={message('value')} />
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-validFrom`} className="form-label small">
            {t('payments.coupons.validFrom')}
          </label>
          <input
            type="datetime-local"
            className={`form-control form-control-sm ${invalidClass('validFrom')}`}
            {...fieldProps('validFrom')}
            {...register('validFrom')}
          />
          <FieldError id={errorId('validFrom')} message={message('validFrom')} />
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-validTo`} className="form-label small">
            {t('payments.coupons.validTo')}
          </label>
          <input
            type="datetime-local"
            className={`form-control form-control-sm ${invalidClass('validTo')}`}
            {...fieldProps('validTo')}
            {...register('validTo')}
          />
          <FieldError id={errorId('validTo')} message={message('validTo')} />
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-maxUses`} className="form-label small">
            {t('payments.coupons.maxUses')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('maxUses')}`}
            {...fieldProps('maxUses', true)}
            {...register('maxUses')}
          />
          <FieldError id={errorId('maxUses')} message={message('maxUses')} />
          <div id={`${id}-maxUses-hint`} className="form-text">
            {t('payments.coupons.maxUsesHint')}
          </div>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-perUserLimit`} className="form-label small">
            {t('payments.coupons.perUserLimit')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('perUserLimit')}`}
            {...fieldProps('perUserLimit')}
            {...register('perUserLimit')}
          />
          <FieldError id={errorId('perUserLimit')} message={message('perUserLimit')} />
        </div>
        <div className="col-md-4 d-flex align-items-end">
          <div className="form-check form-switch mb-1">
            <input
              id={`${id}-active`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('active')}
            />
            <label htmlFor={`${id}-active`} className="form-check-label">
              {t('payments.coupons.activeField')}
            </label>
          </div>
        </div>
      </div>
      <fieldset className="mb-3" aria-describedby={`${id}-planCodes-hint`}>
        <legend className="form-label fs-6">{t('payments.coupons.planCodes')}</legend>
        <p id={`${id}-planCodes-hint`} className="small cb-text-secondary mb-1">
          {t('payments.coupons.planCodesHint')}
        </p>
        <div className="d-flex flex-wrap gap-3">
          {codeOptions.map((code) => (
            <div className="form-check" key={code}>
              <input
                id={`${id}-plan-${code}`}
                type="checkbox"
                className="form-check-input"
                checked={planCodes.includes(code)}
                onChange={(e) =>
                  setValue(
                    'planCodes',
                    e.target.checked ? [...planCodes, code] : planCodes.filter((c) => c !== code),
                  )
                }
              />
              <label htmlFor={`${id}-plan-${code}`} className="form-check-label font-monospace">
                {code}
              </label>
            </div>
          ))}
        </div>
        <FieldError id={errorId('planCodes')} message={message('planCodes')} />
      </fieldset>
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {coupon ? t('payments.coupons.save') : t('payments.coupons.create')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => onDone(null)}
        >
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

export function CouponsPage() {
  const { t, i18n } = useTranslation();
  const canManage = useCan('payments.manage');
  const coupons = useCoupons();
  const [editing, setEditing] = useState<CouponSummary | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const validityWindow = (c: CouponSummary) => {
    const from = c.validFrom ? formatDateTime(c.validFrom, i18n.language) : null;
    const to = c.validTo ? formatDateTime(c.validTo, i18n.language) : null;
    if (!from && !to) return t('payments.coupons.always');
    if (!to) return t('payments.coupons.fromOnly', { from });
    if (!from) return t('payments.coupons.untilOnly', { to });
    return t('payments.coupons.between', { from, to });
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('payments.coupons.title')}</h1>
      <p className="cb-text-secondary">{t('payments.coupons.subtitle')}</p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => {
            setNotice(null);
            setEditing('new');
          }}
        >
          {t('payments.coupons.new')}
        </button>
      )}
      {editing !== null && (
        <CouponEditor
          key={editing === 'new' ? 'new' : editing.id}
          coupon={editing === 'new' ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) setNotice(t('payments.coupons.saved', { code: saved.code }));
          }}
        />
      )}
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('payments.coupons.listLabel')}
      >
        {coupons.isPending && <LoadingRow />}
        {coupons.isError && (
          <div className="m-3">
            <ErrorAlert error={paymentsError(t, coupons.error)} />
          </div>
        )}
        {coupons.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('payments.coupons.code')}</th>
                  <th scope="col">{t('payments.coupons.discount')}</th>
                  <th scope="col">{t('payments.coupons.window')}</th>
                  <th scope="col" className="text-end">
                    {t('payments.coupons.uses')}
                  </th>
                  <th scope="col" className="text-end">
                    {t('payments.coupons.perUser')}
                  </th>
                  <th scope="col">{t('payments.coupons.plans')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('library.updated')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {coupons.data.length === 0 && (
                  <tr>
                    <td colSpan={9} className="cb-text-secondary">
                      {t('payments.coupons.empty')}
                    </td>
                  </tr>
                )}
                {coupons.data.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      <code>{c.code}</code>
                    </th>
                    <td>{discountLabel(c)}</td>
                    <td className="small">{validityWindow(c)}</td>
                    <td className="text-end">
                      {c.maxUses === null
                        ? t('payments.coupons.usedUnlimited', { used: c.usedCount })
                        : t('payments.coupons.usedOf', { used: c.usedCount, max: c.maxUses })}
                    </td>
                    <td className="text-end">{c.perUserLimit}</td>
                    <td className="small">
                      {c.planCodes.length === 0
                        ? t('payments.coupons.allPlans')
                        : c.planCodes.join(', ')}
                    </td>
                    <td>
                      <ActiveBadge active={c.active} />
                    </td>
                    <td className="small">{formatDateTime(c.updatedAt, i18n.language)}</td>
                    <td className="text-end">
                      {canManage && editing === null && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          aria-label={t('payments.coupons.editLabel', { code: c.code })}
                          onClick={() => {
                            setNotice(null);
                            setEditing(c);
                          }}
                        >
                          {t('library.edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
