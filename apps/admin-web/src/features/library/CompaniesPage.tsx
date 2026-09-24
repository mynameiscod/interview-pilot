import { zodResolver } from '@hookform/resolvers/zod';
import {
  CompetencyCategory,
  PatternSourceType,
  RoleFamily,
  type CompanySummary,
  type UpsertCompanyBody,
} from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useFieldArray, useForm, type FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import {
  fieldError,
  formatDateTime,
  libraryError,
  slugify,
  validationIssues,
  type Issue,
} from './format';
import { ActiveBadge, IssueList } from './shared';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const optionalUrl = z
  .string()
  .trim()
  .max(2000, 'library.errors.url')
  .refine((v) => v === '' || isHttpUrl(v), 'library.errors.url');

const CompanyForm = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'library.companies.errors.name')
    .max(120, 'library.companies.errors.name'),
  slug: z
    .string()
    .trim()
    .min(2, 'library.errors.slug')
    .max(60, 'library.errors.slug')
    .regex(SLUG, 'library.errors.slug'),
  website: optionalUrl,
  description: z.string().trim().max(1000, 'library.companies.errors.description'),
  roleFamilies: z.array(RoleFamily),
  allowedQuestionCategories: z.array(CompetencyCategory),
  active: z.boolean(),
  patterns: z
    .array(
      z.object({
        note: z
          .string()
          .trim()
          .min(5, 'library.companies.errors.note')
          .max(500, 'library.companies.errors.note'),
        sourceType: PatternSourceType,
        sourceUrl: optionalUrl,
        verifiedBy: z.string().nullable(),
        verifiedAt: z.string().nullable(),
      }),
    )
    .max(30, 'library.companies.errors.patternCount'),
});
type CompanyFormValues = z.infer<typeof CompanyForm>;

const toForm = (company: CompanySummary | null): CompanyFormValues =>
  company
    ? {
        name: company.name,
        slug: company.slug,
        website: company.website ?? '',
        description: company.description ?? '',
        roleFamilies: company.roleFamilies,
        allowedQuestionCategories: company.allowedQuestionCategories,
        active: company.active,
        patterns: company.verifiedPatterns.map((p) => ({
          note: p.note,
          sourceType: p.sourceType,
          sourceUrl: p.sourceUrl ?? '',
          verifiedBy: p.verifiedBy,
          verifiedAt: p.verifiedAt,
        })),
      }
    : {
        name: '',
        slug: '',
        website: '',
        description: '',
        roleFamilies: [],
        allowedQuestionCategories: [...CompetencyCategory.options],
        active: true,
        patterns: [],
      };

const toBody = (values: CompanyFormValues): UpsertCompanyBody => ({
  name: values.name.trim(),
  slug: values.slug.trim(),
  description: values.description.trim() || null,
  website: values.website.trim() || null,
  roleFamilies: values.roleFamilies,
  allowedQuestionCategories: values.allowedQuestionCategories,
  active: values.active,
  verifiedPatterns: values.patterns.map((p) => ({
    note: p.note.trim(),
    sourceType: p.sourceType,
    sourceUrl: p.sourceUrl.trim() || null,
  })),
});

/** Server issue paths use the API body's names; the form calls the list `patterns`. */
const formPath = (path: string) => path.replace(/^verifiedPatterns\b/, 'patterns');

const KNOWN_PATH =
  /^(name|slug|website|description|roleFamilies|allowedQuestionCategories|active|patterns\.\d+\.(note|sourceType|sourceUrl))$/;

const invalid = (message: string | undefined) => (message ? true : undefined);

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div id={id} className="invalid-feedback d-block">
      {fieldError(t, message)}
    </div>
  );
}

function CompanyEditor({
  company,
  onDone,
}: {
  company: CompanySummary | null;
  onDone: (saved: CompanySummary | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [slugTouched, setSlugTouched] = useState(company !== null);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<CompanyFormValues>({
    resolver: zodResolver(CompanyForm),
    defaultValues: toForm(company),
  });
  const patterns = useFieldArray({ control, name: 'patterns' });
  const nameField = register('name');
  const slugField = register('slug');

  const errorId = (name: string) => `${id}-${name.replace(/\./g, '-')}-error`;

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={handleSubmit(async (values) => {
        setError(null);
        setIssues([]);
        try {
          const body = toBody(values);
          const saved = company
            ? await manager.api.put<CompanySummary>(`/admin/companies/${company.id}`, body)
            : await manager.api.post<CompanySummary>('/admin/companies', body);
          await queryClient.invalidateQueries({ queryKey: ['library', 'companies'] });
          onDone(saved);
        } catch (err) {
          if (err instanceof ApiClientError && err.code === 'CONFLICT') {
            setFieldError('slug', { message: 'library.companies.errors.slugTaken' });
            return;
          }
          const found = validationIssues(err);
          const unmatched = found.filter((issue) => {
            const path = formPath(issue.path);
            if (!KNOWN_PATH.test(path)) return true;
            setFieldError(path as FieldPath<CompanyFormValues>, { message: issue.message });
            return false;
          });
          setIssues(unmatched);
          setError(found.length > 0 ? null : libraryError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {company
          ? t('library.companies.editTitle', { name: company.name })
          : t('library.companies.newTitle')}
      </h2>
      <div className="row g-2 mb-3">
        <div className="col-md-6">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('library.companies.name')}
          </label>
          <input
            id={`${id}-name`}
            className={`form-control form-control-sm ${errors.name ? 'is-invalid' : ''}`}
            aria-invalid={invalid(errors.name?.message)}
            aria-describedby={errors.name ? errorId('name') : undefined}
            {...nameField}
            onChange={(e) => {
              void nameField.onChange(e);
              if (!slugTouched) setValue('slug', slugify(e.target.value));
            }}
          />
          <FieldError id={errorId('name')} message={errors.name?.message} />
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-slug`} className="form-label small">
            {t('library.slug')}
          </label>
          <input
            id={`${id}-slug`}
            className={`form-control form-control-sm font-monospace ${errors.slug ? 'is-invalid' : ''}`}
            spellCheck={false}
            aria-invalid={invalid(errors.slug?.message)}
            aria-describedby={[errors.slug ? errorId('slug') : '', `${id}-slug-hint`]
              .join(' ')
              .trim()}
            {...slugField}
            onChange={(e) => {
              setSlugTouched(true);
              void slugField.onChange(e);
            }}
          />
          <FieldError id={errorId('slug')} message={errors.slug?.message} />
          <div id={`${id}-slug-hint`} className="form-text">
            {t('library.slugHint')}
          </div>
        </div>
        <div className="col-md-6">
          <label htmlFor={`${id}-website`} className="form-label small">
            {t('library.companies.website')}
          </label>
          <input
            id={`${id}-website`}
            type="url"
            className={`form-control form-control-sm ${errors.website ? 'is-invalid' : ''}`}
            placeholder="https://"
            aria-invalid={invalid(errors.website?.message)}
            aria-describedby={errors.website ? errorId('website') : undefined}
            {...register('website')}
          />
          <FieldError id={errorId('website')} message={errors.website?.message} />
        </div>
        <div className="col-md-6 d-flex align-items-end">
          <div className="form-check form-switch mb-1">
            <input
              id={`${id}-active`}
              type="checkbox"
              role="switch"
              className="form-check-input"
              {...register('active')}
            />
            <label htmlFor={`${id}-active`} className="form-check-label">
              {t('library.companies.activeField')}
            </label>
          </div>
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-description`} className="form-label small">
            {t('library.companies.description')}
          </label>
          <textarea
            id={`${id}-description`}
            rows={3}
            className={`form-control form-control-sm ${errors.description ? 'is-invalid' : ''}`}
            aria-invalid={invalid(errors.description?.message)}
            aria-describedby={errors.description ? errorId('description') : undefined}
            {...register('description')}
          />
          <FieldError id={errorId('description')} message={errors.description?.message} />
        </div>
      </div>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.companies.roleFamilies')}</legend>
        <div className="d-flex flex-wrap gap-3">
          {RoleFamily.options.map((f) => (
            <div className="form-check" key={f}>
              <input
                id={`${id}-family-${f}`}
                type="checkbox"
                className="form-check-input"
                value={f}
                {...register('roleFamilies')}
              />
              <label htmlFor={`${id}-family-${f}`} className="form-check-label">
                {t(`library.families.${f}`)}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.companies.categories')}</legend>
        <p className="small cb-text-secondary mb-1">{t('library.companies.categoriesHint')}</p>
        <div className="d-flex flex-wrap gap-3">
          {CompetencyCategory.options.map((c) => (
            <div className="form-check" key={c}>
              <input
                id={`${id}-category-${c}`}
                type="checkbox"
                className="form-check-input"
                value={c}
                {...register('allowedQuestionCategories')}
              />
              <label htmlFor={`${id}-category-${c}`} className="form-check-label">
                {t(`library.categories.${c}`)}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.companies.patterns')}</legend>
        <p className="small cb-text-secondary mb-2">{t('library.companies.patternsHint')}</p>
        {patterns.fields.length === 0 && (
          <p className="small cb-text-secondary">{t('library.companies.noPatterns')}</p>
        )}
        {patterns.fields.map((field, index) => {
          const n = index + 1;
          const rowErrors = errors.patterns?.[index];
          return (
            <div
              key={field.id}
              className="p-2 cb-surface-muted rounded-2 mb-2"
              role="group"
              aria-label={t('library.companies.patternLabel', { n })}
            >
              <div className="row g-2">
                <div className="col-12">
                  <label htmlFor={`${id}-p${index}-note`} className="form-label small mb-0">
                    {t('library.companies.patternNote', { n })}
                  </label>
                  <textarea
                    id={`${id}-p${index}-note`}
                    rows={2}
                    className={`form-control form-control-sm ${rowErrors?.note ? 'is-invalid' : ''}`}
                    aria-invalid={invalid(rowErrors?.note?.message)}
                    aria-describedby={
                      rowErrors?.note ? errorId(`patterns.${index}.note`) : undefined
                    }
                    {...register(`patterns.${index}.note`)}
                  />
                  <FieldError
                    id={errorId(`patterns.${index}.note`)}
                    message={rowErrors?.note?.message}
                  />
                </div>
                <div className="col-md-4">
                  <label htmlFor={`${id}-p${index}-type`} className="form-label small mb-0">
                    {t('library.companies.sourceType', { n })}
                  </label>
                  <select
                    id={`${id}-p${index}-type`}
                    className="form-select form-select-sm"
                    {...register(`patterns.${index}.sourceType`)}
                  >
                    {PatternSourceType.options.map((s) => (
                      <option key={s} value={s}>
                        {t(`library.patternSources.${s}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-md-8">
                  <label htmlFor={`${id}-p${index}-url`} className="form-label small mb-0">
                    {t('library.companies.sourceUrl', { n })}
                  </label>
                  <input
                    id={`${id}-p${index}-url`}
                    type="url"
                    placeholder="https://"
                    className={`form-control form-control-sm ${rowErrors?.sourceUrl ? 'is-invalid' : ''}`}
                    aria-invalid={invalid(rowErrors?.sourceUrl?.message)}
                    aria-describedby={
                      rowErrors?.sourceUrl ? errorId(`patterns.${index}.sourceUrl`) : undefined
                    }
                    {...register(`patterns.${index}.sourceUrl`)}
                  />
                  <FieldError
                    id={errorId(`patterns.${index}.sourceUrl`)}
                    message={rowErrors?.sourceUrl?.message}
                  />
                </div>
              </div>
              <div className="d-flex flex-wrap justify-content-between align-items-center mt-2 gap-2">
                <span className="small cb-text-secondary">
                  {field.verifiedAt
                    ? t('library.companies.verifiedBy', {
                        by: field.verifiedBy ?? '—',
                        date: formatDateTime(field.verifiedAt, i18n.language),
                      })
                    : t('library.companies.verifiedOnSave')}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  aria-label={t('library.companies.removePatternLabel', { n })}
                  onClick={() => patterns.remove(index)}
                >
                  {t('library.companies.removePattern')}
                </button>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={patterns.fields.length >= 30}
          onClick={() =>
            patterns.append({
              note: '',
              sourceType: 'PUBLIC_POSTING',
              sourceUrl: '',
              verifiedBy: null,
              verifiedAt: null,
            })
          }
        >
          <i className="bi bi-plus-lg me-1" aria-hidden="true" />
          {t('library.companies.addPattern')}
        </button>
      </fieldset>

      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {company ? t('library.companies.save') : t('library.companies.create')}
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

export function CompaniesPage() {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('library.manage');
  const [editing, setEditing] = useState<CompanySummary | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const companies = useQuery({
    queryKey: ['library', 'companies'],
    queryFn: () => manager.api.get<CompanySummary[]>('/admin/companies'),
  });

  return (
    <>
      <h1 className="h3 mb-2">{t('library.companies.title')}</h1>
      <p className="cb-text-secondary">{t('library.companies.subtitle')}</p>
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
          {t('library.companies.new')}
        </button>
      )}
      {editing !== null && (
        <CompanyEditor
          key={editing === 'new' ? 'new' : editing.id}
          company={editing === 'new' ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) setNotice(t('library.companies.saved', { name: saved.name }));
          }}
        />
      )}
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('library.companies.listLabel')}
      >
        {companies.isPending && <LoadingRow />}
        {companies.isError && (
          <div className="m-3">
            <ErrorAlert error={libraryError(t, companies.error)} />
          </div>
        )}
        {companies.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.companies.name')}</th>
                  <th scope="col">{t('library.slug')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col" className="text-end">
                    {t('library.companies.patternCount')}
                  </th>
                  <th scope="col">{t('library.updated')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {companies.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="cb-text-secondary">
                      {t('library.companies.empty')}
                    </td>
                  </tr>
                )}
                {companies.data.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      {c.name}
                      {c.website && (
                        <div className="small fw-normal cb-text-secondary text-truncate">
                          {c.website}
                        </div>
                      )}
                    </th>
                    <td>
                      <code>{c.slug}</code>
                    </td>
                    <td>
                      <ActiveBadge active={c.active} />
                    </td>
                    <td className="text-end">{c.verifiedPatterns.length}</td>
                    <td className="small">{formatDateTime(c.updatedAt, i18n.language)}</td>
                    <td className="text-end">
                      {canManage && editing === null && (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-primary"
                          aria-label={t('library.companies.editLabel', { name: c.name })}
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
