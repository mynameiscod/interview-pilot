import { zodResolver } from '@hookform/resolvers/zod';
import {
  ExperienceLevel,
  InterviewLanguagePreference,
  type MeResponse,
  type UpdateProfileBody,
} from '@cbi/shared-types';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

const FormSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  preferredInterviewLanguage: InterviewLanguagePreference,
  experienceLevel: z.union([ExperienceLevel, z.literal('')]),
  currentRole: z.string().trim().max(80),
  productUpdatesOptIn: z.boolean(),
});
type FormValues = z.infer<typeof FormSchema>;

interface Props {
  user: MeResponse;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (body: UpdateProfileBody) => Promise<void>;
}

/** Onboarding and profile editing. Only the name is required. */
export function ProfileForm({ user, submitLabel, pendingLabel, onSubmit }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      displayName: user.profile.displayName ?? '',
      preferredInterviewLanguage: user.profile.preferredInterviewLanguage,
      experienceLevel: user.profile.experienceLevel ?? '',
      currentRole: user.profile.currentRole ?? '',
      productUpdatesOptIn: user.profile.productUpdatesOptIn,
    },
  });

  const field = (name: string) => `${id}-${name}`;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) =>
        onSubmit({
          displayName: values.displayName,
          preferredInterviewLanguage: values.preferredInterviewLanguage,
          experienceLevel: values.experienceLevel === '' ? null : values.experienceLevel,
          currentRole: values.currentRole === '' ? null : values.currentRole,
          productUpdatesOptIn: values.productUpdatesOptIn,
        }),
      )}
    >
      <div className="mb-3">
        <label htmlFor={field('name')} className="form-label">
          {t('profileForm.displayName')}
        </label>
        <input
          id={field('name')}
          className={`form-control ${errors.displayName ? 'is-invalid' : ''}`}
          autoComplete="name"
          aria-invalid={errors.displayName ? true : undefined}
          aria-describedby={errors.displayName ? field('name-error') : undefined}
          {...register('displayName')}
        />
        {errors.displayName && (
          <div id={field('name-error')} className="invalid-feedback" role="alert">
            {t('profileForm.displayNameRequired')}
          </div>
        )}
      </div>

      <div className="mb-3">
        <label htmlFor={field('lang')} className="form-label">
          {t('profileForm.interviewLanguage')}
        </label>
        <select
          id={field('lang')}
          className="form-select"
          aria-describedby={field('lang-hint')}
          {...register('preferredInterviewLanguage')}
        >
          {InterviewLanguagePreference.options.map((lng) => (
            <option key={lng} value={lng}>
              {t(`profileForm.languages.${lng}`)}
            </option>
          ))}
        </select>
        <div id={field('lang-hint')} className="form-text">
          {t('profileForm.interviewLanguageHint')}
        </div>
      </div>

      <div className="mb-3">
        <label htmlFor={field('exp')} className="form-label">
          {t('profileForm.experienceLevel')}
        </label>
        <select id={field('exp')} className="form-select" {...register('experienceLevel')}>
          <option value="">{t('profileForm.notSpecified')}</option>
          {ExperienceLevel.options.map((level) => (
            <option key={level} value={level}>
              {t(`profileForm.experience.${level}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label htmlFor={field('role')} className="form-label">
          {t('profileForm.currentRole')}
        </label>
        <input
          id={field('role')}
          className="form-control"
          placeholder={t('profileForm.currentRolePlaceholder')}
          autoComplete="organization-title"
          {...register('currentRole')}
        />
      </div>

      <div className="form-check mb-4">
        <input
          id={field('updates')}
          type="checkbox"
          className="form-check-input"
          {...register('productUpdatesOptIn')}
        />
        <label htmlFor={field('updates')} className="form-check-label">
          {t('profileForm.productUpdates')}
        </label>
      </div>

      <button type="submit" className="btn btn-primary btn-lg" disabled={isSubmitting}>
        {isSubmitting ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
