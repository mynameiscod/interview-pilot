import {
  CreateCampaignBody,
  InterviewLanguagePreference,
  InterviewMode,
  type CampaignWithInvite,
  type TemplateSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { validationIssues, type Issue } from '../library/format';
import { useRoles } from '../library/queries';
import { IssueList } from '../library/shared';
import { issueFields, localInputToIso, optionalInt } from '../payments/format';
import { FieldError } from '../payments/shared';
import { campaignError } from './format';
import { campaignKeys, useCompanies, useTemplates } from './queries';

type CreateFormValues = {
  name: string;
  companyId: string;
  companyName: string;
  roleId: string;
  templateKey: string;
  jobDescription: string;
  modes: string[];
  languages: string[];
  startAt: string;
  endAt: string;
  maxCandidates: string;
  recording: 'OFF' | 'OPTIONAL' | 'REQUIRED';
  tabSwitchTracking: boolean;
  candidateSeesReport: boolean;
  sponsoredCredits: string;
};
type CreateField = keyof CreateFormValues;

const PATH_FIELDS: Record<string, CreateField> = {
  'window.startAt': 'startAt',
  'window.endAt': 'endAt',
  'proctoring.recording': 'recording',
  'proctoring.tabSwitchTracking': 'tabSwitchTracking',
};

function createField(path: string): CreateField | null {
  if (PATH_FIELDS[path]) return PATH_FIELDS[path];
  const root = path.split('.')[0] ?? '';
  const known: CreateField[] = [
    'name',
    'companyId',
    'companyName',
    'roleId',
    'templateKey',
    'jobDescription',
    'modes',
    'languages',
    'maxCandidates',
    'candidateSeesReport',
    'sponsoredCredits',
  ];
  return (known as string[]).includes(root) ? (root as CreateField) : null;
}

const asArray = (value: string[] | string | false | undefined): string[] =>
  Array.isArray(value) ? value : value ? [value] : [];

/** The API body; invalid numbers become NaN so the shared schema rejects them. */
const toCreateBody = (values: CreateFormValues, now: string) => ({
  name: values.name.trim(),
  companyId: values.companyId || null,
  companyName: values.companyName.trim(),
  roleId: values.roleId,
  templateKey: values.templateKey,
  jobDescription: values.jobDescription.trim() || null,
  modes: asArray(values.modes),
  languages: asArray(values.languages),
  // No start means "from now"; an unparseable date stays invalid.
  window: {
    startAt: values.startAt ? (localInputToIso(values.startAt) ?? '') : now,
    endAt: values.endAt ? (localInputToIso(values.endAt) ?? '') : null,
  },
  maxCandidates: optionalInt(values.maxCandidates),
  proctoring: { recording: values.recording, tabSwitchTracking: values.tabSwitchTracking },
  candidateSeesReport: values.candidateSeesReport,
  sponsoredCredits: optionalInt(values.sponsoredCredits),
});

const createResolver: Resolver<CreateFormValues> = async (values) => {
  const parsed = CreateCampaignBody.safeParse(toCreateBody(values, new Date().toISOString()));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<CreateFormValues> = {};
  for (const field of issueFields(parsed.error, createField)) {
    errors[field] = { type: 'validation', message: `campaigns.errors.${field}` };
  }
  return { values: {}, errors };
};

/** The newest ACTIVE version of each template key (the one a campaign pins). */
function activeTemplates(templates: TemplateSummary[]): TemplateSummary[] {
  const byKey = new Map<string, TemplateSummary>();
  for (const tpl of templates) {
    if (tpl.status !== 'ACTIVE') continue;
    const seen = byKey.get(tpl.key);
    if (!seen || seen.version < tpl.version) byKey.set(tpl.key, tpl);
  }
  return [...byKey.values()].sort((a, b) => a.content.name.localeCompare(b.content.name));
}

const DEFAULTS: CreateFormValues = {
  name: '',
  companyId: '',
  companyName: '',
  roleId: '',
  templateKey: '',
  jobDescription: '',
  modes: ['TEXT'],
  languages: ['auto'],
  startAt: '',
  endAt: '',
  maxCandidates: '',
  recording: 'OFF',
  tabSwitchTracking: false,
  candidateSeesReport: true,
  sponsoredCredits: '',
};

export function CampaignCreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (result: CampaignWithInvite) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const roles = useRoles();
  const templates = useTemplates();
  const companies = useCompanies();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<CreateFormValues>({ resolver: createResolver, defaultValues: DEFAULTS });

  const templateOptions = useMemo(() => activeTemplates(templates.data ?? []), [templates.data]);
  const roleOptions = useMemo(
    () => (roles.data ?? []).filter((r) => r.active && r.activeBlueprintId !== null),
    [roles.data],
  );
  const templateKey = useWatch({ control, name: 'templateKey' });
  const offeredModes = templateOptions.find((tpl) => tpl.key === templateKey)?.content.modes;

  const errorId = (name: CreateField) => `${id}-${name}-error`;
  const fieldProps = (name: CreateField, hint?: boolean) => ({
    id: `${id}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby':
      [errors[name] ? errorId(name) : '', hint ? `${id}-${name}-hint` : ''].join(' ').trim() ||
      undefined,
  });
  const invalidClass = (name: CreateField) => (errors[name] ? 'is-invalid' : '');
  const message = (name: CreateField) => {
    const key = errors[name]?.message;
    return key ? t(key) : undefined;
  };

  if (roles.isPending || templates.isPending || companies.isPending) return <LoadingRow />;

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        setIssues([]);
        try {
          const created = await manager.api.post<CampaignWithInvite>(
            '/admin/campaigns',
            CreateCampaignBody.parse(toCreateBody(values, new Date().toISOString())),
          );
          await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
          onCreated(created);
        } catch (err) {
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : campaignError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('campaigns.create.title')}
      </h2>
      <p className="small cb-text-secondary">{t('campaigns.create.hint')}</p>
      <ErrorAlert
        error={
          roles.isError || templates.isError || companies.isError
            ? t('campaigns.create.libraryFailed')
            : null
        }
      />
      <div className="row g-2 mb-3">
        <div className="col-md-6">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('campaigns.fields.name')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('name')}`}
            {...fieldProps('name')}
            {...register('name')}
          />
          <FieldError id={errorId('name')} message={message('name')} />
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-companyId`} className="form-label small">
            {t('campaigns.fields.libraryCompany')}
          </label>
          <select
            className="form-select form-select-sm"
            {...fieldProps('companyId', true)}
            {...register('companyId', {
              onChange: (e: { target: { value: string } }) => {
                const company = companies.data?.find((c) => c.id === e.target.value);
                if (company && !getValues('companyName').trim()) {
                  setValue('companyName', company.name);
                }
              },
            })}
          >
            <option value="">{t('campaigns.fields.noLibraryCompany')}</option>
            {(companies.data ?? [])
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <div id={`${id}-companyId-hint`} className="form-text">
            {t('campaigns.fields.libraryCompanyHint')}
          </div>
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-companyName`} className="form-label small">
            {t('campaigns.fields.companyName')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('companyName')}`}
            {...fieldProps('companyName')}
            {...register('companyName')}
          />
          <FieldError id={errorId('companyName')} message={message('companyName')} />
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-roleId`} className="form-label small">
            {t('campaigns.fields.role')}
          </label>
          <select
            className={`form-select form-select-sm ${invalidClass('roleId')}`}
            {...fieldProps('roleId', true)}
            {...register('roleId')}
          >
            <option value="">{t('campaigns.fields.chooseRole')}</option>
            {roleOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          <FieldError id={errorId('roleId')} message={message('roleId')} />
          <div id={`${id}-roleId-hint`} className="form-text">
            {t('campaigns.fields.roleHint')}
          </div>
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-templateKey`} className="form-label small">
            {t('campaigns.fields.template')}
          </label>
          <select
            className={`form-select form-select-sm ${invalidClass('templateKey')}`}
            {...fieldProps('templateKey', true)}
            {...register('templateKey', {
              onChange: (e: { target: { value: string } }) => {
                const tpl = templateOptions.find((x) => x.key === e.target.value);
                if (!tpl) return;
                // Keep only the modes this interview type offers; start from its proctoring policy.
                const kept = asArray(getValues('modes')).filter((m) =>
                  tpl.content.modes.includes(m as InterviewMode),
                );
                setValue('modes', kept.length > 0 ? kept : [tpl.content.modes[0]!]);
                setValue('recording', tpl.content.proctoringPolicy.recording);
                setValue('tabSwitchTracking', tpl.content.proctoringPolicy.tabSwitchTracking);
              },
            })}
          >
            <option value="">{t('campaigns.fields.chooseTemplate')}</option>
            {templateOptions.map((tpl) => (
              <option key={tpl.key} value={tpl.key}>
                {t('campaigns.fields.templateOption', {
                  name: tpl.content.name,
                  key: tpl.key,
                  version: tpl.version,
                })}
              </option>
            ))}
          </select>
          <FieldError id={errorId('templateKey')} message={message('templateKey')} />
          <div id={`${id}-templateKey-hint`} className="form-text">
            {t('campaigns.fields.templateHint')}
          </div>
        </div>
        <fieldset
          className="col-md-6"
          aria-describedby={errors.modes ? errorId('modes') : undefined}
        >
          <legend className="form-label small mb-1">{t('campaigns.fields.modes')}</legend>
          {InterviewMode.options.map((mode) => (
            <div className="form-check form-check-inline" key={mode}>
              <input
                id={`${id}-mode-${mode}`}
                type="checkbox"
                className="form-check-input"
                value={mode}
                disabled={offeredModes !== undefined && !offeredModes.includes(mode)}
                {...register('modes')}
              />
              <label htmlFor={`${id}-mode-${mode}`} className="form-check-label">
                {t(`library.modes.${mode}`)}
              </label>
            </div>
          ))}
          <FieldError id={errorId('modes')} message={message('modes')} />
        </fieldset>
        <fieldset
          className="col-md-6"
          aria-describedby={errors.languages ? errorId('languages') : undefined}
        >
          <legend className="form-label small mb-1">{t('campaigns.fields.languages')}</legend>
          {InterviewLanguagePreference.options.map((lang) => (
            <div className="form-check form-check-inline" key={lang}>
              <input
                id={`${id}-lang-${lang}`}
                type="checkbox"
                className="form-check-input"
                value={lang}
                {...register('languages')}
              />
              <label htmlFor={`${id}-lang-${lang}`} className="form-check-label">
                {t(`campaigns.languages.${lang}`)}
              </label>
            </div>
          ))}
          <FieldError id={errorId('languages')} message={message('languages')} />
        </fieldset>
        <div className="col-md-3">
          <label htmlFor={`${id}-startAt`} className="form-label small">
            {t('campaigns.fields.startAt')}
          </label>
          <input
            type="datetime-local"
            className={`form-control form-control-sm ${invalidClass('startAt')}`}
            {...fieldProps('startAt', true)}
            {...register('startAt')}
          />
          <FieldError id={errorId('startAt')} message={message('startAt')} />
          <div id={`${id}-startAt-hint`} className="form-text">
            {t('campaigns.fields.startAtHint')}
          </div>
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-endAt`} className="form-label small">
            {t('campaigns.fields.endAt')}
          </label>
          <input
            type="datetime-local"
            className={`form-control form-control-sm ${invalidClass('endAt')}`}
            {...fieldProps('endAt', true)}
            {...register('endAt')}
          />
          <FieldError id={errorId('endAt')} message={message('endAt')} />
          <div id={`${id}-endAt-hint`} className="form-text">
            {t('campaigns.fields.endAtHint')}
          </div>
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-maxCandidates`} className="form-label small">
            {t('campaigns.fields.maxCandidates')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('maxCandidates')}`}
            {...fieldProps('maxCandidates', true)}
            {...register('maxCandidates')}
          />
          <FieldError id={errorId('maxCandidates')} message={message('maxCandidates')} />
          <div id={`${id}-maxCandidates-hint`} className="form-text">
            {t('campaigns.fields.maxCandidatesHint')}
          </div>
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-sponsoredCredits`} className="form-label small">
            {t('campaigns.fields.sponsoredCredits')}
          </label>
          <input
            type="number"
            min={1}
            className={`form-control form-control-sm ${invalidClass('sponsoredCredits')}`}
            {...fieldProps('sponsoredCredits', true)}
            {...register('sponsoredCredits')}
          />
          <FieldError id={errorId('sponsoredCredits')} message={message('sponsoredCredits')} />
          <div id={`${id}-sponsoredCredits-hint`} className="form-text">
            {t('campaigns.fields.sponsoredCreditsHint')}
          </div>
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-recording`} className="form-label small">
            {t('campaigns.fields.recording')}
          </label>
          <select
            className="form-select form-select-sm"
            {...fieldProps('recording')}
            {...register('recording')}
          >
            {(['OFF', 'OPTIONAL', 'REQUIRED'] as const).map((r) => (
              <option key={r} value={r}>
                {t(`library.recording.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-8 d-flex flex-column justify-content-end">
          <div className="form-check form-switch">
            <input
              id={`${id}-tabSwitchTracking`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('tabSwitchTracking')}
            />
            <label htmlFor={`${id}-tabSwitchTracking`} className="form-check-label">
              {t('campaigns.fields.tabSwitchTracking')}
            </label>
          </div>
          <div className="form-check form-switch">
            <input
              id={`${id}-candidateSeesReport`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('candidateSeesReport')}
            />
            <label htmlFor={`${id}-candidateSeesReport`} className="form-check-label">
              {t('campaigns.fields.candidateSeesReport')}
            </label>
          </div>
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-jobDescription`} className="form-label small">
            {t('campaigns.fields.jobDescription')}
          </label>
          <textarea
            rows={4}
            className={`form-control form-control-sm ${invalidClass('jobDescription')}`}
            {...fieldProps('jobDescription', true)}
            {...register('jobDescription')}
          />
          <FieldError id={errorId('jobDescription')} message={message('jobDescription')} />
          <div id={`${id}-jobDescription-hint`} className="form-text">
            {t('campaigns.fields.jobDescriptionHint')}
          </div>
        </div>
      </div>
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {t('campaigns.create.submit')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}
