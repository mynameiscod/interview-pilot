import { UpdateCampaignBody, type CampaignSummary } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { validationIssues, type Issue } from '../library/format';
import { IssueList } from '../library/shared';
import { isoToLocalInput, issueFields, localInputToIso, optionalInt } from '../payments/format';
import { FieldError } from '../payments/shared';
import { campaignError } from './format';
import { campaignKeys } from './queries';

type EditFormValues = {
  name: string;
  companyName: string;
  jobDescription: string;
  startAt: string;
  endAt: string;
  maxCandidates: string;
  candidateSeesReport: boolean;
  sponsoredCredits: string;
  reason: string;
};
type EditField = keyof EditFormValues;

function editField(path: string): EditField | null {
  if (path === 'window.startAt' || path === 'window') return 'startAt';
  if (path === 'window.endAt') return 'endAt';
  const known: EditField[] = [
    'name',
    'companyName',
    'jobDescription',
    'maxCandidates',
    'candidateSeesReport',
    'sponsoredCredits',
    'reason',
  ];
  return (known as string[]).includes(path) ? (path as EditField) : null;
}

const toForm = (c: CampaignSummary): EditFormValues => ({
  name: c.name,
  companyName: c.companyName,
  jobDescription: c.jobDescription ?? '',
  startAt: isoToLocalInput(c.window.startAt),
  endAt: isoToLocalInput(c.window.endAt),
  maxCandidates: c.maxCandidates === null ? '' : String(c.maxCandidates),
  candidateSeesReport: c.candidateSeesReport,
  sponsoredCredits: c.sponsoredCredits === null ? '' : String(c.sponsoredCredits.total),
  reason: '',
});

const toUpdateBody = (values: EditFormValues) => ({
  name: values.name.trim(),
  companyName: values.companyName.trim(),
  jobDescription: values.jobDescription.trim() || null,
  window: {
    startAt: localInputToIso(values.startAt) ?? '',
    endAt: values.endAt ? (localInputToIso(values.endAt) ?? '') : null,
  },
  maxCandidates: optionalInt(values.maxCandidates),
  candidateSeesReport: values.candidateSeesReport,
  sponsoredCredits: optionalInt(values.sponsoredCredits),
  reason: values.reason.trim(),
});

const editResolver: Resolver<EditFormValues> = async (values) => {
  const parsed = UpdateCampaignBody.safeParse(toUpdateBody(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<EditFormValues> = {};
  for (const field of issueFields(parsed.error, editField)) {
    errors[field] = { type: 'validation', message: `campaigns.errors.${field}` };
  }
  return { values: {}, errors };
};

/** Name, dates, limit, budget and report visibility; the role, template and modes stay pinned. */
export function CampaignEditForm({
  campaign,
  onDone,
}: {
  campaign: CampaignSummary;
  onDone: (saved: boolean) => void;
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
  } = useForm<EditFormValues>({ resolver: editResolver, defaultValues: toForm(campaign) });

  const errorId = (name: EditField) => `${id}-${name}-error`;
  const fieldProps = (name: EditField) => ({
    id: `${id}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? errorId(name) : undefined,
  });
  const invalidClass = (name: EditField) => (errors[name] ? 'is-invalid' : '');
  const message = (name: EditField) => {
    const key = errors[name]?.message;
    return key ? t(key) : undefined;
  };
  const input = (name: EditField, label: string, type = 'text', col = 'col-md-6') => (
    <div className={col}>
      <label htmlFor={`${id}-${name}`} className="form-label small">
        {label}
      </label>
      <input
        type={type}
        className={`form-control form-control-sm ${invalidClass(name)}`}
        {...fieldProps(name)}
        {...register(name)}
      />
      <FieldError id={errorId(name)} message={message(name)} />
    </div>
  );

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        setIssues([]);
        try {
          const saved = await manager.api.put<CampaignSummary>(
            `/admin/campaigns/${campaign.id}`,
            UpdateCampaignBody.parse(toUpdateBody(values)),
          );
          queryClient.setQueryData(campaignKeys.campaign(campaign.id), saved);
          await queryClient.invalidateQueries({ queryKey: campaignKeys.list });
          onDone(true);
        } catch (err) {
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : campaignError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('campaigns.edit.title')}
      </h2>
      <p className="small cb-text-secondary">{t('campaigns.edit.hint')}</p>
      <div className="row g-2 mb-3">
        {input('name', t('campaigns.fields.name'))}
        {input('companyName', t('campaigns.fields.companyName'))}
        {input('startAt', t('campaigns.fields.startAt'), 'datetime-local', 'col-md-3')}
        {input('endAt', t('campaigns.fields.endAt'), 'datetime-local', 'col-md-3')}
        {input('maxCandidates', t('campaigns.fields.maxCandidates'), 'number', 'col-md-3')}
        {input('sponsoredCredits', t('campaigns.fields.sponsoredCredits'), 'number', 'col-md-3')}
        <div className="col-12">
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
            {...fieldProps('jobDescription')}
            {...register('jobDescription')}
          />
          <FieldError id={errorId('jobDescription')} message={message('jobDescription')} />
        </div>
        {input('reason', t('ai.reason'), 'text', 'col-12')}
      </div>
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {t('campaigns.edit.submit')}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => onDone(false)}
        >
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}
