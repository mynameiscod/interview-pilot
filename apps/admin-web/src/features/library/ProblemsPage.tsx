import {
  CODING_LANGUAGE_LABELS,
  type Difficulty,
  type ProblemSummary,
  type ProblemTest,
} from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime, libraryError } from './format';
import { ProblemEditor } from './ProblemEditor';
import { problemKeys, useProblems } from './queries';
import { ActiveBadge } from './shared';

type Editing = { key: string | null; from: ProblemSummary | null } | null;
type Panel = { id: string; mode: 'view' | 'activate' | 'deactivate' } | null;

const DIFFICULTY_BADGE: Record<Difficulty, string> = {
  EASY: 'text-bg-success',
  MEDIUM: 'text-bg-warning',
  HARD: 'text-bg-danger',
};

function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${DIFFICULTY_BADGE[difficulty]}`}>
      {t(`library.difficulty.${difficulty}`)}
    </span>
  );
}

/** `inline code` in backticks renders as code; everything else is plain text. */
function inlineCode(text: string): ReactNode[] {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) =>
      part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

/** Plain-text statement: blank lines separate paragraphs, single newlines are kept. */
function Statement({ text }: { text: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim() !== '');
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {inlineCode(p)}
        </p>
      ))}
    </>
  );
}

function Code({ children, label }: { children: string; label: string }) {
  return (
    <pre
      className="cb-surface-muted border cb-border rounded-2 p-2 mb-0 small font-monospace"
      aria-label={label}
      tabIndex={0}
    >
      <code>{children}</code>
    </pre>
  );
}

function TestList({ tests, hidden }: { tests: ProblemTest[]; hidden: boolean }) {
  const { t } = useTranslation();
  return (
    <ol className="list-unstyled mb-0">
      {tests.map((test, i) => {
        const n = i + 1;
        const label = hidden
          ? t('library.problems.hiddenTestN', { n })
          : t('library.problems.visibleTestN', { n });
        return (
          <li key={i} className="mb-2">
            <div className="fw-semibold small mb-1">{label}</div>
            <div className="row g-2">
              <div className="col-md-6">
                <div className="small cb-text-secondary">{t('library.problems.input')}</div>
                <Code label={t('library.problems.inputLabel', { label })}>{test.input}</Code>
              </div>
              <div className="col-md-6">
                <div className="small cb-text-secondary">
                  {t('library.problems.expectedOutput')}
                </div>
                <Code label={t('library.problems.expectedOutputLabel', { label })}>
                  {test.expectedOutput}
                </Code>
              </div>
            </div>
            {test.explanation && <p className="small mt-1 mb-0">{test.explanation}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** Everything admins review before activating: statement, starter code, all tests. */
function ProblemViewer({ problem }: { problem: ProblemSummary }) {
  const { t } = useTranslation();
  const label = `${problem.key} ${t('library.version', { n: problem.version })}`;
  return (
    <article className="small" aria-label={t('library.problems.viewerLabel', { label })}>
      <h3 className="h6 mb-1">{problem.title}</h3>
      <p className="cb-text-secondary">
        <DifficultyBadge difficulty={problem.difficulty} />{' '}
        {t('library.problems.limitsSummary', problem.limits)}
        {problem.tags.length > 0 && <> · {problem.tags.join(', ')}</>}
      </p>
      <section aria-label={t('library.problems.statement')}>
        <Statement text={problem.statement} />
      </section>

      <h4 className="h6 mt-3">{t('library.problems.starterCode')}</h4>
      {problem.languages.map((lang) => (
        <div key={lang} className="mb-2">
          <div className="cb-text-secondary">{CODING_LANGUAGE_LABELS[lang]}</div>
          <Code
            label={t('library.problems.starterFor', { language: CODING_LANGUAGE_LABELS[lang] })}
          >
            {problem.starterCode[lang] ?? ''}
          </Code>
        </div>
      ))}

      <section aria-label={t('library.problems.visibleTests')} className="mt-3">
        <h4 className="h6">
          {t('library.problems.visibleTests')}{' '}
          <span className="badge text-bg-light border">{t('library.problems.visibleBadge')}</span>
        </h4>
        <TestList tests={problem.visibleTests} hidden={false} />
      </section>

      <section
        aria-label={t('library.problems.hiddenTests')}
        className="mt-3 p-2 border border-dark-subtle rounded-2"
      >
        <h4 className="h6">
          {t('library.problems.hiddenTests')}{' '}
          <span className="badge text-bg-dark">
            <i className="bi bi-eye-slash me-1" aria-hidden="true" />
            {t('library.problems.hiddenBadge')}
          </span>
        </h4>
        <TestList tests={problem.hiddenTests} hidden />
      </section>
    </article>
  );
}

function ProblemRow({
  problem,
  panel,
  setPanel,
  canManage,
  editing,
  onEdit,
  onChanged,
}: {
  problem: ProblemSummary;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onChanged: (problem: ProblemSummary, active: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === problem.id ? panel.mode : null;
  const version = t('library.version', { n: problem.version });
  const label = `${problem.key} ${version}`;
  const toggle = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason: string }) =>
      manager.api.post<ProblemSummary>(
        `/admin/problems/${encodeURIComponent(problem.id)}/${active ? 'activate' : 'deactivate'}`,
        { reason },
      ),
    onSuccess: async (_saved, { active }) => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: problemKeys.all });
      onChanged(problem, active);
    },
    onError: (err) => setError(libraryError(t, err)),
  });

  return (
    <>
      <tr className={problem.active ? 'table-success' : undefined}>
        <th scope="row">{version}</th>
        <td>{problem.title}</td>
        <td>
          <DifficultyBadge difficulty={problem.difficulty} />
        </td>
        <td className="small">
          {t('library.problems.testCounts', {
            visible: problem.visibleTests.length,
            hidden: problem.hiddenTests.length,
          })}
        </td>
        <td>
          <ActiveBadge active={problem.active} />
        </td>
        <td className="small">{formatDateTime(problem.createdAt, i18n.language)}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('library.problems.viewLabel', { label })}
              onClick={() => setPanel(mode === 'view' ? null : { id: problem.id, mode: 'view' })}
            >
              {mode === 'view' ? t('library.hide') : t('library.view')}
            </button>
            {canManage && !editing && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  aria-label={t('library.problems.editLabel', { label })}
                  onClick={onEdit}
                >
                  {t('library.edit')}
                </button>
                {!problem.active && mode !== 'activate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    aria-label={t('library.problems.activateLabel', { label })}
                    onClick={() => {
                      setError(null);
                      setPanel({ id: problem.id, mode: 'activate' });
                    }}
                  >
                    {t('library.activate')}
                  </button>
                )}
                {problem.active && mode !== 'deactivate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    aria-label={t('library.problems.deactivateLabel', { label })}
                    onClick={() => {
                      setError(null);
                      setPanel({ id: problem.id, mode: 'deactivate' });
                    }}
                  >
                    {t('library.problems.deactivate')}
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {mode && (
        <tr>
          <td colSpan={7}>
            {mode === 'view' && <ProblemViewer problem={problem} />}
            {(mode === 'activate' || mode === 'deactivate') && (
              <ReasonForm
                submitLabel={
                  mode === 'activate'
                    ? t('library.problems.confirmActivate', { label })
                    : t('library.problems.confirmDeactivate', { label })
                }
                danger={mode === 'deactivate'}
                pending={toggle.isPending}
                error={error}
                onSubmit={(reason) => toggle.mutate({ active: mode === 'activate', reason })}
                onCancel={() => {
                  setPanel(null);
                  setError(null);
                }}
              >
                <ul className="small">
                  {mode === 'activate' ? (
                    <>
                      <li>
                        {t('library.problems.activateExplain', { key: problem.key, version })}
                      </li>
                      <li>{t('library.problems.activateInProgress')}</li>
                    </>
                  ) : (
                    <>
                      <li>{t('library.problems.deactivateExplain', { key: problem.key })}</li>
                      <li>{t('library.problems.activateInProgress')}</li>
                    </>
                  )}
                </ul>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ActiveSummary({ problem }: { problem: ProblemSummary }) {
  const { t } = useTranslation();
  return (
    <div className="small">
      <div>
        <span className="fw-semibold">{problem.title}</span>{' '}
        <span className="cb-text-secondary">({t('library.version', { n: problem.version })})</span>{' '}
        <DifficultyBadge difficulty={problem.difficulty} />
      </div>
      <div className="cb-text-secondary">
        {problem.languages.map((lang) => CODING_LANGUAGE_LABELS[lang]).join(', ')}
        {' · '}
        {t('library.problems.testCounts', {
          visible: problem.visibleTests.length,
          hidden: problem.hiddenTests.length,
        })}
        {' · '}
        {t('library.problems.limitsSummary', problem.limits)}
      </div>
      {problem.tags.length > 0 && (
        <ul className="list-inline mb-0 mt-1" aria-label={t('library.problems.tags')}>
          {problem.tags.map((tag) => (
            <li key={tag} className="list-inline-item">
              <span className="badge text-bg-light border">{tag}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProblemsPage() {
  const { t } = useTranslation();
  const canManage = useCan('library.manage');
  const problems = useProblems();
  const [editing, setEditing] = useState<Editing>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = new Map<string, ProblemSummary[]>();
  for (const problem of problems.data ?? []) {
    groups.set(problem.key, [...(groups.get(problem.key) ?? []), problem]);
  }
  for (const list of groups.values()) list.sort((a, b) => b.version - a.version);
  const sortedKeys = [...groups.keys()].sort();

  const startEditing = (next: Editing) => {
    setNotice(null);
    setPanel(null);
    setEditing(next);
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('library.problems.title')}</h1>
      <p className="cb-text-secondary">{t('library.problems.subtitle')}</p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => startEditing({ key: null, from: null })}
        >
          {t('library.problems.new')}
        </button>
      )}
      {editing && (
        <ProblemEditor
          problemKey={editing.key}
          from={editing.from}
          onDone={(created) => {
            setEditing(null);
            if (created) {
              setNotice(
                t('library.problems.created', {
                  key: created.key,
                  version: t('library.version', { n: created.version }),
                }),
              );
            }
          }}
        />
      )}
      {problems.isPending && <LoadingRow />}
      {problems.isError && <ErrorAlert error={libraryError(t, problems.error)} />}
      {problems.data && problems.data.length === 0 && (
        <p className="cb-text-secondary">{t('library.problems.empty')}</p>
      )}
      {sortedKeys.map((key) => {
        const versions = groups.get(key)!;
        const active = versions.find((v) => v.active);
        const headingId = `problem-${key}`;
        return (
          <section
            key={key}
            className="border cb-border rounded-3 bg-white mb-3"
            aria-labelledby={headingId}
          >
            <div className="p-3 pb-2">
              <h2 id={headingId} className="h6 mb-1">
                <code>{key}</code>
              </h2>
              {active ? (
                <ActiveSummary problem={active} />
              ) : (
                <div className="small cb-text-secondary">{t('library.problems.noActive')}</div>
              )}
            </div>
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <caption className="visually-hidden">
                  {t('library.problems.historyCaption', { key })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('library.versionHeader')}</th>
                    <th scope="col">{t('library.problems.titleField')}</th>
                    <th scope="col">{t('library.problems.difficulty')}</th>
                    <th scope="col">{t('library.problems.tests')}</th>
                    <th scope="col">{t('ai.status')}</th>
                    <th scope="col">{t('library.created')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('ai.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((problem) => (
                    <ProblemRow
                      key={problem.id}
                      problem={problem}
                      panel={panel}
                      setPanel={setPanel}
                      canManage={canManage}
                      editing={editing !== null}
                      onEdit={() => startEditing({ key, from: problem })}
                      onChanged={(changed, nowActive) =>
                        setNotice(
                          t(
                            nowActive
                              ? 'library.problems.activated'
                              : 'library.problems.deactivated',
                            {
                              key: changed.key,
                              version: t('library.version', { n: changed.version }),
                            },
                          ),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
