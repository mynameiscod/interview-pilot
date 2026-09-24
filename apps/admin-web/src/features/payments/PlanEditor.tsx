import {
  CreatePlanVersionBody,
  PaymentCurrency,
  type PlanContent,
  type PlanSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { validationIssues, type Issue } from '../library/format';
import { IssueList } from '../library/shared';
import { issueFields, paiseToRupees, paymentsError, requiredInt, rupeesToPaise } from './format';
import { paymentsKeys } from './queries';
import { FieldError } from './shared';

type PlanFormValues = {
  code: string;
  name: string;
  description: string;
  price: string;
  currency: PlanContent['currency'];
  credits: string;
  validityDays: string;
  features: string;
  displayOrder: string;
  featured: boolean;
  reason: string;
};
type PlanField = keyof PlanFormValues;

const CONTENT_FIELDS: Record<string, PlanField> = {
  name: 'name',
  description: 'description',
  priceMinor: 'price',
  currency: 'currency',
  credits: 'credits',
  validityDays: 'validityDays',
  features: 'features',
  displayOrder: 'displayOrder',
  featured: 'featured',
};

function planField(path: string): PlanField | null {
  if (path === 'code' || path === 'reason') return path;
  const [root, key] = path.split('.');
  return root === 'content' && key ? (CONTENT_FIELDS[key] ?? null) : null;
}

const toForm = (code: string | null, content: PlanContent | null): PlanFormValues => ({
  code: code ?? '',
  name: content?.name ?? '',
  description: content?.description ?? '',
  price: content ? paiseToRupees(content.priceMinor) : '',
  currency: content?.currency ?? 'INR',
  credits: content ? String(content.credits) : '',
  validityDays: content?.validityDays == null ? '' : String(content.validityDays),
  features: content?.features.join('\n') ?? '',
  displayOrder: content ? String(content.displayOrder) : '0',
  featured: content?.featured ?? false,
  reason: '',
});

/** The API body; invalid numbers become NaN so the shared schema rejects them. */
const toPlanBody = (values: PlanFormValues) => ({
  code: values.code.trim().toUpperCase(),
  content: {
    name: values.name.trim(),
    description: values.description.trim(),
    priceMinor: rupeesToPaise(values.price),
    currency: values.currency,
    credits: requiredInt(values.credits),
    validityDays: values.validityDays.trim() === '' ? null : requiredInt(values.validityDays),
    features: values.features
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
    displayOrder: requiredInt(values.displayOrder),
    featured: values.featured,
  },
  reason: values.reason.trim(),
});

/** Validates with the shared CreatePlanVersionBody; messages are i18n keys per field. */
const planResolver: Resolver<PlanFormValues> = async (values) => {
  const parsed = CreatePlanVersionBody.safeParse(toPlanBody(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<PlanFormValues> = {};
  for (const field of issueFields(parsed.error, planField)) {
    errors[field] = { type: 'validation', message: `payments.plans.errors.${field}` };
  }
  return { values: {}, errors };
};

export function PlanEditor({
  code,
  initial,
  onDone,
}: {
  /** Null starts a new plan code. */
  code: string | null;
  initial: PlanContent | null;
  onDone: (created: PlanSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PlanFormValues>({ resolver: planResolver, defaultValues: toForm(code, initial) });

  const errorId = (name: PlanField) => `${id}-${name}-error`;
  const fieldProps = (name: PlanField, hint?: string) => ({
    id: `${id}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby':
      [errors[name] ? errorId(name) : '', hint ? `${id}-${name}-hint` : ''].join(' ').trim() ||
      undefined,
  });
  const invalidClass = (name: PlanField) => (errors[name] ? 'is-invalid' : '');
  const message = (name: PlanField) => {
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
          const created = await manager.api.post<PlanSummary>(
            '/admin/plans',
            CreatePlanVersionBody.parse(toPlanBody(values)),
          );
          await queryClient.invalidateQueries({ queryKey: paymentsKeys.plans });
          onDone(created);
        } catch (err) {
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : paymentsError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {code ? t('payments.plans.newVersionTitle', { code }) : t('payments.plans.newTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('payments.plans.editorHint')}</p>
      <div className="row g-2 mb-3">
        <div className="col-md-4">
          <label htmlFor={`${id}-code`} className="form-label small">
            {t('payments.plans.code')}
          </label>
          <input
            className={`form-control form-control-sm font-monospace ${invalidClass('code')}`}
            spellCheck={false}
            readOnly={code !== null}
            {...fieldProps('code', 'hint')}
            {...register('code')}
          />
          <FieldError id={errorId('code')} message={message('code')} />
          <div id={`${id}-code-hint`} className="form-text">
            {t('payments.plans.codeHint')}
          </div>
        </div>
        <div className="col-md-8">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('payments.plans.name')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('name')}`}
            {...fieldProps('name')}
            {...register('name')}
          />
          <FieldError id={errorId('name')} message={message('name')} />
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-description`} className="form-label small">
            {t('payments.plans.description')}
          </label>
          <textarea
            rows={2}
            className={`form-control form-control-sm ${invalidClass('description')}`}
            {...fieldProps('description')}
            {...register('description')}
          />
          <FieldError id={errorId('description')} message={message('description')} />
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-price`} className="form-label small">
            {t('payments.plans.priceRupees')}
          </label>
          <div className="input-group input-group-sm">
            <span className="input-group-text">₹</span>
            <input
              inputMode="decimal"
              className={`form-control ${invalidClass('price')}`}
              {...fieldProps('price', 'hint')}
              {...register('price')}
            />
          </div>
          <FieldError id={errorId('price')} message={message('price')} />
          <div id={`${id}-price-hint`} className="form-text">
            {t('payments.plans.priceHint')}
          </div>
        </div>
        <div className="col-md-2">
          <label htmlFor={`${id}-currency`} className="form-label small">
            {t('payments.plans.currency')}
          </label>
          <select
            className="form-select form-select-sm"
            {...fieldProps('currency')}
            {...register('currency')}
          >
            {PaymentCurrency.options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-credits`} className="form-label small">
            {t('payments.plans.credits')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('credits')}`}
            {...fieldProps('credits')}
            {...register('credits')}
          />
          <FieldError id={errorId('credits')} message={message('credits')} />
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-validityDays`} className="form-label small">
            {t('payments.plans.validityDays')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('validityDays')}`}
            {...fieldProps('validityDays', 'hint')}
            {...register('validityDays')}
          />
          <FieldError id={errorId('validityDays')} message={message('validityDays')} />
          <div id={`${id}-validityDays-hint`} className="form-text">
            {t('payments.plans.validityHint')}
          </div>
        </div>
        <div className="col-md-8">
          <label htmlFor={`${id}-features`} className="form-label small">
            {t('payments.plans.features')}
          </label>
          <textarea
            rows={4}
            className={`form-control form-control-sm ${invalidClass('features')}`}
            {...fieldProps('features', 'hint')}
            {...register('features')}
          />
          <FieldError id={errorId('features')} message={message('features')} />
          <div id={`${id}-features-hint`} className="form-text">
            {t('payments.plans.featuresHint')}
          </div>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-displayOrder`} className="form-label small">
            {t('payments.plans.displayOrder')}
          </label>
          <input
            type="number"
            min={0}
            className={`form-control form-control-sm ${invalidClass('displayOrder')}`}
            {...fieldProps('displayOrder')}
            {...register('displayOrder')}
          />
          <FieldError id={errorId('displayOrder')} message={message('displayOrder')} />
          <div className="form-check form-switch mt-3">
            <input
              id={`${id}-featured`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('featured')}
            />
            <label htmlFor={`${id}-featured`} className="form-check-label">
              {t('payments.plans.featured')}
            </label>
          </div>
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-reason`} className="form-label small">
            {t('ai.reason')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('reason')}`}
            {...fieldProps('reason')}
            {...register('reason')}
          />
          <FieldError id={errorId('reason')} message={message('reason')} />
        </div>
      </div>
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {t('payments.plans.createVersion')}
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
