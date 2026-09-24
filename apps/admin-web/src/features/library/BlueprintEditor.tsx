import { BlueprintContent, type BlueprintSummary } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { competencyWeightTotal } from './blueprint-diff';
import { libraryError, validationIssues, type Issue } from './format';
import { IssueList } from './shared';

type Parsed = { value: unknown; error: null } | { value: null; error: string };

function parse(text: string): Parsed {
  try {
    return { value: JSON.parse(text) as unknown, error: null };
  } catch (err) {
    return { value: null, error: (err as Error).message };
  }
}

type EditableCompetency = { key?: unknown; name?: unknown; weight?: unknown };

/**
 * A validated JSON editor for a new blueprint version, with a structured
 * weight table on top: weights are what admins adjust most, and they must
 * total exactly 100.
 */
export function BlueprintEditor({
  roleId,
  initial,
  onDone,
}: {
  roleId: string;
  initial: unknown;
  onDone: (created: BlueprintSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parse(text), [text]);
  const total = parsed.error === null ? competencyWeightTotal(parsed.value) : null;
  const competencies: EditableCompetency[] =
    parsed.error === null &&
    Array.isArray((parsed.value as { competencies?: unknown } | null)?.competencies)
      ? (parsed.value as { competencies: EditableCompetency[] }).competencies
      : [];

  const create = useMutation({
    mutationFn: (content: BlueprintContent) =>
      manager.api.post<BlueprintSummary>(`/admin/roles/${roleId}/blueprints`, {
        content,
        reason: reason.trim(),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      onDone(created);
    },
    onError: (err) => {
      const found = validationIssues(err);
      setIssues(found);
      setError(found.length > 0 ? null : libraryError(t, err));
    },
  });

  const setWeight = (index: number, weight: number) => {
    if (parsed.error !== null) return;
    const next = structuredClone(parsed.value) as { competencies: EditableCompetency[] };
    next.competencies[index] = { ...next.competencies[index], weight };
    setText(JSON.stringify(next, null, 2));
  };

  const submit = () => {
    setError(null);
    if (parsed.error !== null) {
      setIssues([{ path: '', message: t('library.editor.invalidJson', { error: parsed.error }) }]);
      return;
    }
    const result = BlueprintContent.safeParse(parsed.value);
    if (!result.success) {
      setIssues(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      return;
    }
    setIssues([]);
    create.mutate(result.data);
  };

  const totalOk = total === 100;
  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('library.blueprints.newTitle')}
      </h2>
      <p className="small cb-text-secondary">{t('library.blueprints.newHint')}</p>

      {competencies.length > 0 && (
        <fieldset className="mb-3">
          <legend className="form-label fs-6">{t('library.blueprints.weightsLegend')}</legend>
          <div className="row g-2">
            {competencies.map((c, index) => {
              const name = typeof c.name === 'string' && c.name ? c.name : String(index + 1);
              return (
                <div className="col-sm-6 col-lg-4" key={index}>
                  <label htmlFor={`${id}-w-${index}`} className="form-label small mb-0">
                    {t('library.blueprints.weightFor', { name })}
                  </label>
                  <input
                    id={`${id}-w-${index}`}
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    className="form-control form-control-sm"
                    value={typeof c.weight === 'number' ? c.weight : ''}
                    onChange={(e) => setWeight(index, Number(e.target.value))}
                  />
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
      <p
        id={`${id}-total`}
        className={`small fw-semibold ${totalOk ? 'text-success' : 'text-danger'}`}
        aria-live="polite"
      >
        {total === null
          ? t('library.blueprints.totalUnknown')
          : totalOk
            ? t('library.blueprints.totalOk', { total })
            : t('library.blueprints.totalBad', { total })}
      </p>

      <label htmlFor={`${id}-json`} className="form-label small">
        {t('library.blueprints.contentJson')}
      </label>
      <textarea
        id={`${id}-json`}
        className={`form-control font-monospace small mb-1 ${parsed.error || issues.length ? 'is-invalid' : ''}`}
        rows={18}
        spellCheck={false}
        value={text}
        aria-invalid={parsed.error !== null || issues.length > 0 ? true : undefined}
        aria-describedby={`${id}-total ${id}-json-status ${id}-issues`}
        onChange={(e) => setText(e.target.value)}
      />
      <div id={`${id}-json-status`} className="small mb-2" aria-live="polite">
        {parsed.error !== null && (
          <span className="text-danger">
            {t('library.editor.invalidJson', { error: parsed.error })}
          </span>
        )}
      </div>
      <IssueList id={`${id}-issues`} issues={issues} />

      <label htmlFor={`${id}-reason`} className="form-label">
        {t('ai.reason')}
      </label>
      <input
        id={`${id}-reason`}
        className="form-control mb-2"
        value={reason}
        minLength={3}
        maxLength={300}
        required
        onChange={(e) => setReason(e.target.value)}
      />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={create.isPending || reason.trim().length < 3}
        >
          {t('library.saveDraft')}
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
