import {
  CODING_LANGUAGE_LABELS,
  CODING_LIMITS,
  CodingLanguage,
  CreateProblemVersionBody,
  Difficulty,
  type ProblemContent,
  type ProblemSummary,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  useFieldArray,
  useForm,
  useWatch,
  type Control,
  type FieldError as FormFieldError,
  type FieldErrors,
  type Resolver,
  type UseFormRegister,
} from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { issueFields, requiredInt } from '../payments/format';
import { FieldError } from '../payments/shared';
import { libraryError, splitList, validationIssues, type Issue } from './format';
import { problemKeys } from './queries';
import { IssueList } from './shared';

const MAX_VISIBLE_TESTS = 5;

type TestRow = { input: string; expectedOutput: string; explanation: string };

type ProblemFormValues = {
  key: string;
  title: string;
  statement: string;
  difficulty: Difficulty;
  tags: string;
  languages: CodingLanguage[];
  starterCode: Record<CodingLanguage, string>;
  visibleTests: TestRow[];
  hiddenTests: TestRow[];
  cpuMs: string;
  memoryMb: string;
  reason: string;
};

type ProblemField =
  | 'key'
  | 'title'
  | 'statement'
  | 'difficulty'
  | 'tags'
  | 'languages'
  | 'starterCode'
  | 'visibleTests'
  | 'hiddenTests'
  | 'cpuMs'
  | 'memoryMb'
  | 'reason';

const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'statement',
  'difficulty',
  'tags',
  'languages',
  'starterCode',
  'visibleTests',
  'hiddenTests',
]);

/** The form field a shared-schema issue path belongs to (a test row maps to its list). */
function problemField(path: string): ProblemField | null {
  if (path === 'key' || path === 'reason') return path;
  const [root, key, sub] = path.split('.');
  if (root !== 'content' || !key) return null;
  if (key === 'limits') return sub === 'cpuMs' || sub === 'memoryMb' ? sub : null;
  return CONTENT_FIELDS.has(key) ? (key as ProblemField) : null;
}

const emptyTest = (): TestRow => ({ input: '', expectedOutput: '', explanation: '' });

const toForm = (key: string | null, content: ProblemContent | null): ProblemFormValues => ({
  key: key ?? '',
  title: content?.title ?? '',
  statement: content?.statement ?? '',
  difficulty: content?.difficulty ?? 'EASY',
  tags: content?.tags.join(', ') ?? '',
  languages: content ? [...content.languages] : ['python'],
  starterCode: Object.fromEntries(
    CodingLanguage.options.map((lang) => [lang, content?.starterCode[lang] ?? '']),
  ) as Record<CodingLanguage, string>,
  visibleTests: content
    ? content.visibleTests.map((test) => ({ ...test, explanation: test.explanation ?? '' }))
    : [emptyTest()],
  hiddenTests: content
    ? content.hiddenTests.map((test) => ({ ...test, explanation: '' }))
    : [emptyTest()],
  cpuMs: content ? String(content.limits.cpuMs) : '2000',
  memoryMb: content ? String(content.limits.memoryMb) : '256',
  reason: '',
});

/** A checkbox group reads back as an array, but be safe about a lone value. */
const selectedLanguages = (value: unknown): CodingLanguage[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  // Keep the canonical order whatever order the boxes were ticked in.
  return CodingLanguage.options.filter((lang) => list.includes(lang));
};

/**
 * The API body. Test input and expected output are compared exactly by the
 * judge, so they are sent as typed (no trimming); starter code likewise.
 */
const toProblemBody = (values: ProblemFormValues) => {
  const languages = selectedLanguages(values.languages);
  return {
    key: values.key.trim(),
    content: {
      title: values.title.trim(),
      statement: values.statement.trim(),
      difficulty: values.difficulty,
      tags: splitList(values.tags),
      languages,
      starterCode: Object.fromEntries(
        languages.map((lang) => [lang, values.starterCode[lang] ?? '']),
      ),
      visibleTests: values.visibleTests.map((test) => ({
        input: test.input,
        expectedOutput: test.expectedOutput,
        explanation: test.explanation.trim() === '' ? null : test.explanation.trim(),
      })),
      hiddenTests: values.hiddenTests.map((test) => ({
        input: test.input,
        expectedOutput: test.expectedOutput,
        explanation: null,
      })),
      limits: { cpuMs: requiredInt(values.cpuMs), memoryMb: requiredInt(values.memoryMb) },
    },
    reason: values.reason.trim(),
  };
};

/** Validates with the shared CreateProblemVersionBody; messages are i18n keys per field. */
const problemResolver: Resolver<ProblemFormValues> = async (values) => {
  const parsed = CreateProblemVersionBody.safeParse(toProblemBody(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<ProblemFormValues> = {};
  for (const field of issueFields(parsed.error, problemField)) {
    errors[field] = { type: 'validation', message: `library.problems.errors.${field}` };
  }
  return { values: {}, errors };
};

function TestRows({
  kind,
  control,
  register,
  invalid,
  describedBy,
}: {
  kind: 'visibleTests' | 'hiddenTests';
  control: Control<ProblemFormValues>;
  register: UseFormRegister<ProblemFormValues>;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { fields, append, remove } = useFieldArray({ control, name: kind });
  const visible = kind === 'visibleTests';
  const max = visible ? MAX_VISIBLE_TESTS : CODING_LIMITS.maxTests;
  const label = (n: number) =>
    visible ? t('library.problems.visibleTestN', { n }) : t('library.problems.hiddenTestN', { n });
  const monoProps = {
    className: `form-control form-control-sm font-monospace ${invalid ? 'is-invalid' : ''}`,
    spellCheck: false,
    rows: 3,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': describedBy,
  } as const;

  return (
    <>
      {fields.length === 0 && (
        <p className="small cb-text-secondary">{t('library.problems.noTests')}</p>
      )}
      {fields.map((field, index) => {
        const n = index + 1;
        const rowId = `${id}-${index}`;
        return (
          <fieldset key={field.id} className="border cb-border rounded-2 p-2 mb-2">
            <legend className="small fw-semibold mb-1">{label(n)}</legend>
            <div className="row g-2">
              <div className="col-md-6">
                <label htmlFor={`${rowId}-input`} className="form-label small mb-0">
                  {t('library.problems.input')}
                </label>
                <textarea
                  id={`${rowId}-input`}
                  aria-label={t('library.problems.inputLabel', { label: label(n) })}
                  {...monoProps}
                  {...register(`${kind}.${index}.input`)}
                />
              </div>
              <div className="col-md-6">
                <label htmlFor={`${rowId}-output`} className="form-label small mb-0">
                  {t('library.problems.expectedOutput')}
                </label>
                <textarea
                  id={`${rowId}-output`}
                  aria-label={t('library.problems.expectedOutputLabel', { label: label(n) })}
                  {...monoProps}
                  {...register(`${kind}.${index}.expectedOutput`)}
                />
              </div>
              {visible && (
                <div className="col-12">
                  <label htmlFor={`${rowId}-explanation`} className="form-label small mb-0">
                    {t('library.problems.explanationOptional')}
                  </label>
                  <input
                    id={`${rowId}-explanation`}
                    aria-label={t('library.problems.explanationLabel', { label: label(n) })}
                    className="form-control form-control-sm"
                    {...register(`${kind}.${index}.explanation`)}
                  />
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger mt-2"
              aria-label={t('library.problems.removeTest', { label: label(n) })}
              onClick={() => remove(index)}
            >
              <i className="bi bi-trash me-1" aria-hidden="true" />
              {t('library.problems.remove')}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="btn btn-sm btn-outline-primary"
        disabled={fields.length >= max}
        onClick={() => append(emptyTest())}
      >
        <i className="bi bi-plus-lg me-1" aria-hidden="true" />
        {visible ? t('library.problems.addVisibleTest') : t('library.problems.addHiddenTest')}
      </button>
    </>
  );
}

/** Structured editor for a new problem version; versions are never edited in place. */
export function ProblemEditor({
  problemKey,
  from,
  onDone,
}: {
  /** Null starts a new problem key. */
  problemKey: string | null;
  /** The version this draft is prefilled from. */
  from: ProblemSummary | null;
  onDone: (created: ProblemSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProblemFormValues>({
    resolver: problemResolver,
    defaultValues: toForm(problemKey, from),
  });
  const languages = selectedLanguages(useWatch({ control, name: 'languages' }));

  const errorId = (name: ProblemField) => `${id}-${name}-error`;
  const hasError = (name: ProblemField) => Boolean(errors[name]);
  const describedBy = (name: ProblemField, hint?: boolean) =>
    [hasError(name) ? errorId(name) : '', hint ? `${id}-${name}-hint` : ''].join(' ').trim() ||
    undefined;
  const fieldProps = (name: ProblemField, hint?: boolean) => ({
    id: `${id}-${name}`,
    'aria-invalid': hasError(name) ? true : undefined,
    'aria-describedby': describedBy(name, hint),
  });
  const invalidClass = (name: ProblemField) => (hasError(name) ? 'is-invalid' : '');
  const message = (name: ProblemField) => {
    const key = (errors[name] as FormFieldError | undefined)?.message;
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
          const created = await manager.api.post<ProblemSummary>(
            '/admin/problems',
            CreateProblemVersionBody.parse(toProblemBody(values)),
          );
          await queryClient.invalidateQueries({ queryKey: problemKeys.all });
          onDone(created);
        } catch (err) {
          const found = validationIssues(err);
          setIssues(found);
          setError(found.length > 0 ? null : libraryError(t, err));
        }
      })}
    >
      <h2 id={`${id}-heading`} className="h6">
        {problemKey && from
          ? t('library.problems.newVersionTitle', { key: problemKey, version: from.version })
          : t('library.problems.newTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('library.problems.editorHint')}</p>
      <div className="row g-2 mb-3">
        {problemKey === null && (
          <div className="col-md-4">
            <label htmlFor={`${id}-key`} className="form-label small">
              {t('library.problems.key')}
            </label>
            <input
              className={`form-control form-control-sm font-monospace ${invalidClass('key')}`}
              spellCheck={false}
              {...fieldProps('key', true)}
              {...register('key')}
            />
            <FieldError id={errorId('key')} message={message('key')} />
            <div id={`${id}-key-hint`} className="form-text">
              {t('library.problems.keyHint')}
            </div>
          </div>
        )}
        <div className={problemKey === null ? 'col-md-5' : 'col-md-9'}>
          <label htmlFor={`${id}-title`} className="form-label small">
            {t('library.problems.titleField')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('title')}`}
            {...fieldProps('title')}
            {...register('title')}
          />
          <FieldError id={errorId('title')} message={message('title')} />
        </div>
        <div className="col-md-3">
          <label htmlFor={`${id}-difficulty`} className="form-label small">
            {t('library.problems.difficulty')}
          </label>
          <select
            className={`form-select form-select-sm ${invalidClass('difficulty')}`}
            {...fieldProps('difficulty')}
            {...register('difficulty')}
          >
            {Difficulty.options.map((d) => (
              <option key={d} value={d}>
                {t(`library.difficulty.${d}`)}
              </option>
            ))}
          </select>
          <FieldError id={errorId('difficulty')} message={message('difficulty')} />
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-statement`} className="form-label small">
            {t('library.problems.statement')}
          </label>
          <textarea
            rows={8}
            className={`form-control form-control-sm ${invalidClass('statement')}`}
            {...fieldProps('statement', true)}
            {...register('statement')}
          />
          <FieldError id={errorId('statement')} message={message('statement')} />
          <div id={`${id}-statement-hint`} className="form-text">
            {t('library.problems.statementHint')}
          </div>
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-tags`} className="form-label small">
            {t('library.problems.tags')}
          </label>
          <input
            className={`form-control form-control-sm ${invalidClass('tags')}`}
            {...fieldProps('tags', true)}
            {...register('tags')}
          />
          <FieldError id={errorId('tags')} message={message('tags')} />
          <div id={`${id}-tags-hint`} className="form-text">
            {t('library.problems.tagsHint')}
          </div>
        </div>
      </div>

      <fieldset
        className="mb-3"
        aria-invalid={hasError('languages') ? true : undefined}
        aria-describedby={describedBy('languages')}
      >
        <legend className="form-label fs-6">{t('library.problems.languages')}</legend>
        <div className="d-flex flex-wrap gap-3">
          {CodingLanguage.options.map((lang) => (
            <div className="form-check" key={lang}>
              <input
                id={`${id}-lang-${lang}`}
                type="checkbox"
                className="form-check-input"
                value={lang}
                {...register('languages')}
              />
              <label htmlFor={`${id}-lang-${lang}`} className="form-check-label">
                {CODING_LANGUAGE_LABELS[lang]}
              </label>
            </div>
          ))}
        </div>
        <FieldError id={errorId('languages')} message={message('languages')} />
      </fieldset>

      <fieldset className="mb-3" aria-describedby={describedBy('starterCode')}>
        <legend className="form-label fs-6">{t('library.problems.starterCode')}</legend>
        {languages.length === 0 && (
          <p className="small cb-text-secondary">{t('library.problems.chooseLanguage')}</p>
        )}
        {languages.map((lang) => (
          <div className="mb-2" key={lang}>
            <label htmlFor={`${id}-starter-${lang}`} className="form-label small mb-0">
              {t('library.problems.starterFor', { language: CODING_LANGUAGE_LABELS[lang] })}
            </label>
            <textarea
              id={`${id}-starter-${lang}`}
              rows={6}
              spellCheck={false}
              className={`form-control form-control-sm font-monospace ${invalidClass('starterCode')}`}
              aria-invalid={hasError('starterCode') ? true : undefined}
              {...register(`starterCode.${lang}`)}
            />
          </div>
        ))}
        <FieldError id={errorId('starterCode')} message={message('starterCode')} />
      </fieldset>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.problems.visibleTests')}</legend>
        <p className="small cb-text-secondary mb-2">{t('library.problems.visibleTestsHint')}</p>
        <TestRows
          kind="visibleTests"
          control={control}
          register={register}
          invalid={hasError('visibleTests')}
          describedBy={describedBy('visibleTests')}
        />
        <FieldError id={errorId('visibleTests')} message={message('visibleTests')} />
      </fieldset>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">
          {t('library.problems.hiddenTests')}{' '}
          <span className="badge text-bg-dark align-middle">
            <i className="bi bi-eye-slash me-1" aria-hidden="true" />
            {t('library.problems.hiddenBadge')}
          </span>
        </legend>
        <p className="small cb-text-secondary mb-2">{t('library.problems.hiddenTestsHint')}</p>
        <TestRows
          kind="hiddenTests"
          control={control}
          register={register}
          invalid={hasError('hiddenTests')}
          describedBy={describedBy('hiddenTests')}
        />
        <FieldError id={errorId('hiddenTests')} message={message('hiddenTests')} />
      </fieldset>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.problems.limits')}</legend>
        <div className="row g-2">
          <div className="col-md-3">
            <label htmlFor={`${id}-cpuMs`} className="form-label small">
              {t('library.problems.cpuMs')}
            </label>
            <input
              type="number"
              min={100}
              max={10_000}
              className={`form-control form-control-sm ${invalidClass('cpuMs')}`}
              {...fieldProps('cpuMs')}
              {...register('cpuMs')}
            />
            <FieldError id={errorId('cpuMs')} message={message('cpuMs')} />
          </div>
          <div className="col-md-3">
            <label htmlFor={`${id}-memoryMb`} className="form-label small">
              {t('library.problems.memoryMb')}
            </label>
            <input
              type="number"
              min={16}
              max={1024}
              className={`form-control form-control-sm ${invalidClass('memoryMb')}`}
              {...fieldProps('memoryMb')}
              {...register('memoryMb')}
            />
            <FieldError id={errorId('memoryMb')} message={message('memoryMb')} />
          </div>
        </div>
      </fieldset>

      <div className="mb-3">
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
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={isSubmitting}>
          {t('library.problems.createVersion')}
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
