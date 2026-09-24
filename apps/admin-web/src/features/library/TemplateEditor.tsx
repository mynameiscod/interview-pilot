import {
  AVAILABLE_INTERVIEW_MODES,
  CompetencyCategory,
  CreateTemplateVersionBody,
  InterviewMode,
  RoundType,
  TemplateRound,
  templateDurationSec,
  type TemplateContent,
  type TemplateSummary,
} from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth } from '../../app/session';
import { ErrorAlert } from '../ai/shared';
import { libraryError, minutes, validationIssues, type Issue } from './format';
import { IssueList } from './shared';

type Round = TemplateContent['rounds'][number];
type RoundDifficulty = Round['difficulty'];
type Recording = TemplateContent['proctoringPolicy']['recording'];

const ROUND_DIFFICULTIES = TemplateRound.shape.difficulty.options;
const RECORDING: Recording[] = ['OFF', 'OPTIONAL', 'REQUIRED'];

const emptyTemplate = (): TemplateContent => ({
  name: '',
  description: '',
  modes: ['TEXT'],
  rounds: [
    {
      type: 'INTRO',
      durationSec: 300,
      questionCount: 2,
      difficulty: 'EASY',
      followUpDepth: 1,
      minEvidence: 1,
    },
  ],
  codingRequired: false,
  creditCost: 1,
  proctoringPolicy: { recording: 'OFF', tabSwitchTracking: false },
  scoringPolicy: {
    dimensionWeights: {
      TECHNICAL: 35,
      PROBLEM_SOLVING: 25,
      COMMUNICATION: 15,
      BEHAVIORAL: 15,
      DOMAIN: 10,
    },
  },
  reportPolicy: { showDimensionScores: true, showTranscript: true },
});

const int = (value: string) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

const weightTotal = (content: Pick<TemplateContent, 'scoringPolicy'>) =>
  Object.values(content.scoringPolicy.dimensionWeights).reduce((a, b) => a + (b ?? 0), 0);

/** Structured editor for a new template version; versions are never edited in place. */
export function TemplateEditor({
  templateKey,
  initial,
  onDone,
}: {
  /** Null when creating a new template key. */
  templateKey: string | null;
  initial: TemplateContent | null;
  onDone: (created: TemplateSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [key, setKey] = useState(templateKey ?? '');
  const [content, setContent] = useState<TemplateContent>(() =>
    initial ? structuredClone(initial) : emptyTemplate(),
  );
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateTemplateVersionBody) =>
      manager.api.post<TemplateSummary>('/admin/templates', body),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['library', 'templates'] });
      onDone(created);
    },
    onError: (err) => {
      const found = validationIssues(err);
      setIssues(found);
      setError(found.length > 0 ? null : libraryError(t, err));
    },
  });

  const update = (patch: Partial<TemplateContent>) => setContent((c) => ({ ...c, ...patch }));
  const setRound = (index: number, patch: Partial<Round>) =>
    setContent((c) => ({
      ...c,
      rounds: c.rounds.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  const moveRound = (index: number, by: -1 | 1) =>
    setContent((c) => {
      const rounds = [...c.rounds];
      const [round] = rounds.splice(index, 1);
      rounds.splice(index + by, 0, round!);
      return { ...c, rounds };
    });
  const setWeight = (category: CompetencyCategory, weight: number) =>
    setContent((c) => ({
      ...c,
      scoringPolicy: {
        dimensionWeights: { ...c.scoringPolicy.dimensionWeights, [category]: weight },
      },
    }));

  const total = weightTotal(content);
  const totalOk = total === 100;
  const duration = minutes(templateDurationSec(content));

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const result = CreateTemplateVersionBody.safeParse({ key, content, reason });
        if (!result.success) {
          setIssues(
            result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
          return;
        }
        setIssues([]);
        create.mutate(result.data);
      }}
    >
      <h2 id={`${id}-heading`} className="h6">
        {templateKey
          ? t('library.templates.newVersionTitle', { key: templateKey })
          : t('library.templates.newTitle')}
      </h2>
      <div className="row g-2 mb-3">
        {templateKey === null && (
          <div className="col-md-4">
            <label htmlFor={`${id}-key`} className="form-label small">
              {t('library.templates.key')}
            </label>
            <input
              id={`${id}-key`}
              className="form-control form-control-sm font-monospace"
              spellCheck={false}
              aria-describedby={`${id}-key-hint`}
              value={key}
              onChange={(e) => setKey(e.target.value.trim())}
            />
            <div id={`${id}-key-hint`} className="form-text">
              {t('library.slugHint')}
            </div>
          </div>
        )}
        <div className="col-md-8">
          <label htmlFor={`${id}-name`} className="form-label small">
            {t('library.templates.name')}
          </label>
          <input
            id={`${id}-name`}
            className="form-control form-control-sm"
            value={content.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>
        <div className="col-12">
          <label htmlFor={`${id}-description`} className="form-label small">
            {t('library.templates.description')}
          </label>
          <textarea
            id={`${id}-description`}
            rows={2}
            className="form-control form-control-sm"
            value={content.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </div>
      </div>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.templates.rounds')}</legend>
        <div className="table-responsive">
          <table className="table table-sm align-middle small mb-2">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{t('library.templates.roundType')}</th>
                <th scope="col">{t('library.templates.durationMin')}</th>
                <th scope="col">{t('library.templates.questions')}</th>
                <th scope="col">{t('library.templates.difficulty')}</th>
                <th scope="col">{t('library.templates.followUpDepth')}</th>
                <th scope="col">{t('library.templates.minEvidence')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('ai.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {content.rounds.map((round, index) => {
                const n = index + 1;
                return (
                  <tr key={index}>
                    <th scope="row">{n}</th>
                    <td>
                      <select
                        className="form-select form-select-sm"
                        aria-label={t('library.templates.roundTypeLabel', { n })}
                        value={round.type}
                        onChange={(e) => setRound(index, { type: e.target.value as RoundType })}
                      >
                        {RoundType.options.map((r) => (
                          <option key={r} value={r}>
                            {t(`library.roundTypes.${r}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        className="form-control form-control-sm"
                        style={{ width: '5rem' }}
                        aria-label={t('library.templates.durationLabel', { n })}
                        value={minutes(round.durationSec)}
                        onChange={(e) => setRound(index, { durationSec: int(e.target.value) * 60 })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        className="form-control form-control-sm"
                        style={{ width: '5rem' }}
                        aria-label={t('library.templates.questionsLabel', { n })}
                        value={round.questionCount}
                        onChange={(e) => setRound(index, { questionCount: int(e.target.value) })}
                      />
                    </td>
                    <td>
                      <select
                        className="form-select form-select-sm"
                        aria-label={t('library.templates.difficultyLabel', { n })}
                        value={round.difficulty}
                        onChange={(e) =>
                          setRound(index, { difficulty: e.target.value as RoundDifficulty })
                        }
                      >
                        {ROUND_DIFFICULTIES.map((d) => (
                          <option key={d} value={d}>
                            {t(`library.difficulty.${d}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={3}
                        className="form-control form-control-sm"
                        style={{ width: '4.5rem' }}
                        aria-label={t('library.templates.followUpLabel', { n })}
                        value={round.followUpDepth}
                        onChange={(e) => setRound(index, { followUpDepth: int(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        className="form-control form-control-sm"
                        style={{ width: '4.5rem' }}
                        aria-label={t('library.templates.minEvidenceLabel', { n })}
                        value={round.minEvidence}
                        onChange={(e) => setRound(index, { minEvidence: int(e.target.value) })}
                      />
                    </td>
                    <td className="text-nowrap">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary me-1"
                        aria-label={t('library.templates.moveUp', { n })}
                        disabled={index === 0}
                        onClick={() => moveRound(index, -1)}
                      >
                        <i className="bi bi-arrow-up" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary me-1"
                        aria-label={t('library.templates.moveDown', { n })}
                        disabled={index === content.rounds.length - 1}
                        onClick={() => moveRound(index, 1)}
                      >
                        <i className="bi bi-arrow-down" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        aria-label={t('library.templates.removeRound', { n })}
                        disabled={content.rounds.length === 1}
                        onClick={() =>
                          update({ rounds: content.rounds.filter((_, i) => i !== index) })
                        }
                      >
                        <i className="bi bi-trash" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            disabled={content.rounds.length >= 8}
            onClick={() =>
              update({
                rounds: [
                  ...content.rounds,
                  {
                    type: 'TECHNICAL',
                    durationSec: 600,
                    questionCount: 3,
                    difficulty: 'ADAPTIVE',
                    followUpDepth: 2,
                    minEvidence: 2,
                  },
                ],
              })
            }
          >
            <i className="bi bi-plus-lg me-1" aria-hidden="true" />
            {t('library.templates.addRound')}
          </button>
          <span className="small" aria-live="polite">
            {t('library.templates.totalDuration', { minutes: duration })}
          </span>
        </div>
      </fieldset>

      <div className="row g-3 mb-3">
        <fieldset className="col-md-6">
          <legend className="form-label fs-6">{t('library.templates.modes')}</legend>
          <div className="d-flex flex-wrap gap-3">
            {InterviewMode.options.map((mode) => {
              const available = AVAILABLE_INTERVIEW_MODES.includes(mode);
              return (
                <div className="form-check" key={mode}>
                  <input
                    id={`${id}-mode-${mode}`}
                    type="checkbox"
                    className="form-check-input"
                    checked={content.modes.includes(mode)}
                    onChange={(e) =>
                      update({
                        modes: e.target.checked
                          ? [...content.modes, mode]
                          : content.modes.filter((m) => m !== mode),
                      })
                    }
                  />
                  <label htmlFor={`${id}-mode-${mode}`} className="form-check-label">
                    {t(`library.modes.${mode}`)}
                    {!available && (
                      <span className="small cb-text-secondary ms-1">
                        {t('library.templates.modeLater')}
                      </span>
                    )}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="col-md-3">
          <label htmlFor={`${id}-credits`} className="form-label small">
            {t('library.templates.creditCost')}
          </label>
          <input
            id={`${id}-credits`}
            type="number"
            min={0}
            max={10}
            className="form-control form-control-sm"
            value={content.creditCost}
            onChange={(e) => update({ creditCost: int(e.target.value) })}
          />
        </div>
        <div className="col-md-3 d-flex align-items-end">
          <div className="form-check">
            <input
              id={`${id}-coding`}
              type="checkbox"
              className="form-check-input"
              checked={content.codingRequired}
              onChange={(e) => update({ codingRequired: e.target.checked })}
            />
            <label htmlFor={`${id}-coding`} className="form-check-label">
              {t('library.templates.codingRequired')}
            </label>
          </div>
        </div>
      </div>

      <fieldset className="mb-3">
        <legend className="form-label fs-6">{t('library.templates.weights')}</legend>
        <div className="row g-2">
          {CompetencyCategory.options.map((category) => (
            <div className="col-6 col-md" key={category}>
              <label htmlFor={`${id}-weight-${category}`} className="form-label small mb-0">
                {t(`library.categories.${category}`)}
              </label>
              <input
                id={`${id}-weight-${category}`}
                type="number"
                min={0}
                max={100}
                className="form-control form-control-sm"
                aria-describedby={`${id}-weight-total`}
                value={content.scoringPolicy.dimensionWeights[category] ?? 0}
                onChange={(e) => setWeight(category, int(e.target.value))}
              />
            </div>
          ))}
        </div>
        <p
          id={`${id}-weight-total`}
          className={`small fw-semibold mt-2 mb-0 ${totalOk ? 'text-success' : 'text-danger'}`}
          aria-live="polite"
        >
          {totalOk
            ? t('library.templates.weightsOk', { total })
            : t('library.templates.weightsBad', { total })}
        </p>
      </fieldset>

      <div className="row g-3 mb-3">
        <fieldset className="col-md-6">
          <legend className="form-label fs-6">{t('library.templates.proctoring')}</legend>
          <label htmlFor={`${id}-recording`} className="form-label small">
            {t('library.templates.recording')}
          </label>
          <select
            id={`${id}-recording`}
            className="form-select form-select-sm mb-2"
            value={content.proctoringPolicy.recording}
            onChange={(e) =>
              update({
                proctoringPolicy: {
                  ...content.proctoringPolicy,
                  recording: e.target.value as Recording,
                },
              })
            }
          >
            {RECORDING.map((r) => (
              <option key={r} value={r}>
                {t(`library.recording.${r}`)}
              </option>
            ))}
          </select>
          <div className="form-check">
            <input
              id={`${id}-tabs`}
              type="checkbox"
              className="form-check-input"
              checked={content.proctoringPolicy.tabSwitchTracking}
              onChange={(e) =>
                update({
                  proctoringPolicy: {
                    ...content.proctoringPolicy,
                    tabSwitchTracking: e.target.checked,
                  },
                })
              }
            />
            <label htmlFor={`${id}-tabs`} className="form-check-label">
              {t('library.templates.tabSwitchTracking')}
            </label>
          </div>
        </fieldset>
        <fieldset className="col-md-6">
          <legend className="form-label fs-6">{t('library.templates.report')}</legend>
          <div className="form-check">
            <input
              id={`${id}-scores`}
              type="checkbox"
              className="form-check-input"
              checked={content.reportPolicy.showDimensionScores}
              onChange={(e) =>
                update({
                  reportPolicy: { ...content.reportPolicy, showDimensionScores: e.target.checked },
                })
              }
            />
            <label htmlFor={`${id}-scores`} className="form-check-label">
              {t('library.templates.showDimensionScores')}
            </label>
          </div>
          <div className="form-check">
            <input
              id={`${id}-transcript`}
              type="checkbox"
              className="form-check-input"
              checked={content.reportPolicy.showTranscript}
              onChange={(e) =>
                update({
                  reportPolicy: { ...content.reportPolicy, showTranscript: e.target.checked },
                })
              }
            />
            <label htmlFor={`${id}-transcript`} className="form-check-label">
              {t('library.templates.showTranscript')}
            </label>
          </div>
        </fieldset>
      </div>

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
      <IssueList issues={issues} />
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
