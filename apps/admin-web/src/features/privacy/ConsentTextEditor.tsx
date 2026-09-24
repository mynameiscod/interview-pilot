import {
  ConsentLocale,
  ConsentType,
  CreateConsentTextBody,
  type ConsentTextSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert } from '../ai/shared';
import { validationIssues, type Issue } from '../library/format';
import { IssueList } from '../library/shared';
import { issueFields } from '../payments/format';
import { FieldError } from '../payments/shared';
import { privacyKeys } from './queries';

type ConsentFormValues = {
  type: ConsentType;
  locale: ConsentLocale;
  title: string;
  body: string;
  reason: string;
};
type ConsentField = keyof ConsentFormValues;

const FIELDS: ReadonlySet<string> = new Set(['type', 'locale', 'title', 'body', 'reason']);
const consentField = (path: string): ConsentField | null =>
  FIELDS.has(path) ? (path as ConsentField) : null;

const toBody = (values: ConsentFormValues) => ({
  type: values.type,
  locale: values.locale,
  title: values.title.trim(),
  body: values.body.trim(),
  reason: values.reason.trim(),
});

/** Validates with the shared CreateConsentTextBody; messages are i18n keys per field. */
const consentResolver: Resolver<ConsentFormValues> = async (values) => {
  const parsed = CreateConsentTextBody.safeParse(toBody(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<ConsentFormValues> = {};
  for (const field of issueFields(parsed.error, consentField)) {
    errors[field] = { type: 'validation', message: `privacy.consent.errors.${field}` };
  }
  return { values: {}, errors };
};

export type ConsentDraft = {
  type: ConsentType;
  locale: ConsentLocale;
  title: string;
  body: string;
  /** The version this draft starts from; its type and locale are then fixed. */
  from: ConsentTextSummary | null;
};

export function ConsentTextEditor({
  draft,
  onDone,
}: {
  draft: ConsentDraft;
  onDone: (created: ConsentTextSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const fixed = draft.from !== null;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConsentFormValues>({
    resolver: consentResolver,
    defaultValues: {
      type: draft.type,
      locale: draft.locale,
      title: draft.title,
      body: draft.body,
      reason: '',
    },
  });

  const errorId = (name: ConsentField) => `${id}-${name}-error`;
  const fieldProps = (name: ConsentField) => ({
    id: `${id}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? errorId(name) : undefined,
  });
  const invalidClass = (name: ConsentField) => (errors[name] ? 'is-invalid' : '');
  const message = (name: ConsentField) => {
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
          const created = await manager.api.post<ConsentTextSummary>(
            '/admin/consent-texts',
            CreateConsentTextBody.parse(
              toBody(fixed ? { ...values, type: draft.type, locale: draft.locale } : values),
            ),
          );
          await queryClient.invalidateQueries({ queryKey: privacyKeys.consentTexts });
          onDone(created);
        } catch (err) {
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : consoleError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {fixed
          ? t('privacy.consent.newVersionTitle', {
              type: t(`privacy.consentType.${draft.type}`),
              locale: t(`privacy.locale.${draft.locale}`),
              version: draft.from?.version,
            })
          : t('privacy.consent.newTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('privacy.consent.editorHint')}</p>
      <div className="row g-2 mb-3">
        {!fixed && (
          <>
            <div className="col-md-6">
              <label htmlFor={`${id}-type`} className="form-label small">
                {t('privacy.consent.type')}
              </label>
              <select
                className={`form-select form-select-sm ${invalidClass('type')}`}
                {...fieldProps('type')}
                {...register('type')}
              >
                {ConsentType.options.map((type) => (
                  <option key={type} value={type}>
                    {t(`privacy.consentType.${type}`)}
                  </option>
                ))}
              </select>
              <FieldError id={errorId('type')} message={message('type')} />
            </div>
            <div className="col-md-6">
              <label htmlFor={`${id}-locale`} className="form-label small">
                {t('privacy.consent.locale')}
              </label>
              <select
                className={`form-select form-select-sm ${invalidClass('locale')}`}
                {...fieldProps('locale')}
                {...register('locale')}
              >
                {ConsentLocale.options.map((locale) => (
                  <option key={locale} value={locale}>
                    {t(`privacy.locale.${locale}`)}
                  </option>
                ))}
              </select>
              <FieldError id={errorId('locale')} message={message('locale')} />
            </div>
          </>
        )}
        <div className="col-12">
          <label htmlFor={`${id}-title`} className="form-label small">
            {t('privacy.consent.titleField')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('title')}`}
            {...fieldProps('title')}
            {...register('title')}
          />
          <FieldError id={errorId('title')} message={message('title')} />
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-body`} className="form-label small">
            {t('privacy.consent.body')}
          </label>
          <textarea
            rows={8}
            className={`form-control form-control-sm ${invalidClass('body')}`}
            {...fieldProps('body')}
            {...register('body')}
          />
          <FieldError id={errorId('body')} message={message('body')} />
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
          {t('privacy.consent.createVersion')}
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
