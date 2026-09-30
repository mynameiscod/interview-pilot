import {
  CreateDesignPromptVersionBody,
  Difficulty,
  type DesignPromptContent,
  type DesignPromptSummary,
} from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime, libraryError, splitList, validationIssues, type Issue } from './format';
import { designPromptKeys, useDesignPrompts } from './queries';
import { ActiveBadge, IssueList } from './shared';

type Panel = { id: string; mode: 'view' | 'activate' | 'deactivate' } | null;
type Editing = { key: string | null; from: DesignPromptSummary | null } | null;

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Structured editor for a new design prompt version (versions are never edited in place). */
function DesignPromptEditor({
  promptKey,
  from,
  onDone,
}: {
  promptKey: string | null;
  from: DesignPromptSummary | null;
  onDone: (created: DesignPromptSummary | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [key, setKey] = useState(promptKey ?? '');
  const [title, setTitle] = useState(from?.title ?? '');
  const [prompt, setPrompt] = useState(from?.prompt ?? '');
  const [difficulty, setDifficulty] = useState<Difficulty>(from?.difficulty ?? 'MEDIUM');
  const [tags, setTags] = useState(from?.tags.join(', ') ?? '');
  const [focus, setFocus] = useState(from?.focusAreas.join('\n') ?? '');
  const [considerations, setConsiderations] = useState(from?.considerations.join('\n') ?? '');
  const [reason, setReason] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateDesignPromptVersionBody) =>
      manager.api.post<DesignPromptSummary>('/admin/design-prompts', body),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: designPromptKeys.all });
      onDone(created);
    },
    onError: (err) => {
      const found = validationIssues(err);
      setIssues(found);
      setError(found.length > 0 ? null : libraryError(t, err));
    },
  });

  const field = (name: string, label: string, input: ReactNode, hint?: string) => (
    <div className="mb-2">
      <label htmlFor={`${id}-${name}`} className="form-label small mb-0">
        {label}
      </label>
      {input}
      {hint && <div className="form-text">{hint}</div>}
    </div>
  );

  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const content: DesignPromptContent = {
          title,
          prompt,
          difficulty,
          tags: splitList(tags),
          focusAreas: lines(focus),
          considerations: lines(considerations),
        };
        const parsed = CreateDesignPromptVersionBody.safeParse({ key, content, reason });
        if (!parsed.success) {
          setIssues(
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
          return;
        }
        setIssues([]);
        create.mutate(parsed.data);
      }}
    >
      <h2 id={`${id}-heading`} className="h6">
        {promptKey && from
          ? t('library.designPrompts.newVersionTitle', { key: promptKey, version: from.version })
          : t('library.designPrompts.newTitle')}
      </h2>
      {promptKey === null &&
        field(
          'key',
          t('library.designPrompts.key'),
          <input
            id={`${id}-key`}
            className="form-control form-control-sm font-monospace"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />,
          t('library.problems.keyHint'),
        )}
      {field(
        'title',
        t('library.designPrompts.titleField'),
        <input
          id={`${id}-title`}
          className="form-control form-control-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />,
      )}
      {field(
        'prompt',
        t('library.designPrompts.prompt'),
        <textarea
          id={`${id}-prompt`}
          rows={6}
          className="form-control form-control-sm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />,
        t('library.problems.statementHint'),
      )}
      {field(
        'difficulty',
        t('library.designPrompts.difficulty'),
        <select
          id={`${id}-difficulty`}
          className="form-select form-select-sm w-auto"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as Difficulty)}
        >
          {Difficulty.options.map((d) => (
            <option key={d} value={d}>
              {t(`library.difficulty.${d}`)}
            </option>
          ))}
        </select>,
      )}
      {field(
        'tags',
        t('library.designPrompts.tags'),
        <input
          id={`${id}-tags`}
          className="form-control form-control-sm"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />,
        t('library.problems.tagsHint'),
      )}
      {field(
        'focus',
        t('library.designPrompts.focusAreas'),
        <textarea
          id={`${id}-focus`}
          rows={3}
          className="form-control form-control-sm"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />,
        t('library.designPrompts.focusHint'),
      )}
      {field(
        'considerations',
        t('library.designPrompts.considerations'),
        <textarea
          id={`${id}-considerations`}
          rows={6}
          className="form-control form-control-sm"
          value={considerations}
          onChange={(e) => setConsiderations(e.target.value)}
        />,
        t('library.designPrompts.considerationsHint'),
      )}
      {field(
        'reason',
        t('ai.reason'),
        <input
          id={`${id}-reason`}
          className="form-control form-control-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />,
      )}
      <IssueList issues={issues} />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={create.isPending}>
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

function PromptViewer({ prompt }: { prompt: DesignPromptSummary }) {
  const { t } = useTranslation();
  return (
    <article
      className="small"
      aria-label={t('library.designPrompts.viewerLabel', {
        label: `${prompt.key} ${t('library.version', { n: prompt.version })}`,
      })}
    >
      <h3 className="h6">{prompt.title}</h3>
      {prompt.prompt
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {p}
          </p>
        ))}
      <h4 className="h6">{t('library.designPrompts.focusAreas')}</h4>
      <ul>
        {prompt.focusAreas.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      <h4 className="h6">
        {t('library.designPrompts.considerations')}{' '}
        <span className="badge text-bg-dark align-middle">
          <i className="bi bi-eye-slash me-1" aria-hidden="true" />
          {t('library.problems.hiddenBadge')}
        </span>
      </h4>
      <ul className="mb-0">
        {prompt.considerations.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </article>
  );
}

function PromptRow({
  prompt,
  panel,
  setPanel,
  canManage,
  editing,
  onEdit,
  onChanged,
}: {
  prompt: DesignPromptSummary;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onChanged: (prompt: DesignPromptSummary, active: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === prompt.id ? panel.mode : null;
  const version = t('library.version', { n: prompt.version });
  const label = `${prompt.key} ${version}`;
  const toggle = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason: string }) =>
      manager.api.post<DesignPromptSummary>(
        `/admin/design-prompts/${encodeURIComponent(prompt.id)}/${active ? 'activate' : 'deactivate'}`,
        { reason },
      ),
    onSuccess: async (_saved, { active }) => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: designPromptKeys.all });
      onChanged(prompt, active);
    },
    onError: (err) => setError(libraryError(t, err)),
  });

  return (
    <>
      <tr className={prompt.active ? 'table-success' : undefined}>
        <th scope="row">{version}</th>
        <td>{prompt.title}</td>
        <td>{t(`library.difficulty.${prompt.difficulty}`)}</td>
        <td>
          <ActiveBadge active={prompt.active} />
        </td>
        <td className="small">{formatDateTime(prompt.createdAt, i18n.language)}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('library.problems.viewLabel', { label })}
              onClick={() => setPanel(mode === 'view' ? null : { id: prompt.id, mode: 'view' })}
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
                {!prompt.active && mode !== 'activate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    aria-label={t('library.problems.activateLabel', { label })}
                    onClick={() => setPanel({ id: prompt.id, mode: 'activate' })}
                  >
                    {t('library.activate')}
                  </button>
                )}
                {prompt.active && mode !== 'deactivate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    aria-label={t('library.problems.deactivateLabel', { label })}
                    onClick={() => setPanel({ id: prompt.id, mode: 'deactivate' })}
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
          <td colSpan={6}>
            {mode === 'view' ? (
              <PromptViewer prompt={prompt} />
            ) : (
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
                <p className="small">
                  {mode === 'activate'
                    ? t('library.designPrompts.activateExplain', { key: prompt.key, version })
                    : t('library.designPrompts.deactivateExplain', { key: prompt.key })}
                </p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** The system design bank: prompts, their rubric, and which version is asked. */
export function DesignPromptsPage() {
  const { t } = useTranslation();
  const canManage = useCan('library.manage');
  const prompts = useDesignPrompts();
  const [editing, setEditing] = useState<Editing>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = new Map<string, DesignPromptSummary[]>();
  for (const p of prompts.data ?? []) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  for (const list of groups.values()) list.sort((a, b) => b.version - a.version);

  const start = (next: Editing) => {
    setNotice(null);
    setPanel(null);
    setEditing(next);
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('library.designPrompts.title')}</h1>
      <p className="cb-text-secondary">{t('library.designPrompts.subtitle')}</p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => start({ key: null, from: null })}
        >
          {t('library.designPrompts.new')}
        </button>
      )}
      {editing && (
        <DesignPromptEditor
          promptKey={editing.key}
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
      {prompts.isPending && <LoadingRow />}
      {prompts.isError && <ErrorAlert error={libraryError(t, prompts.error)} />}
      {prompts.data && prompts.data.length === 0 && (
        <p className="cb-text-secondary">{t('library.designPrompts.empty')}</p>
      )}
      {[...groups.keys()].sort().map((key) => {
        const versions = groups.get(key)!;
        const headingId = `design-${key}`;
        return (
          <section
            key={key}
            className="border cb-border rounded-3 bg-white mb-3"
            aria-labelledby={headingId}
          >
            <div className="p-3 pb-2">
              <h2 id={headingId} className="h6 mb-0">
                <code>{key}</code>
              </h2>
            </div>
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <caption className="visually-hidden">
                  {t('library.problems.historyCaption', { key })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('library.versionHeader')}</th>
                    <th scope="col">{t('library.designPrompts.titleField')}</th>
                    <th scope="col">{t('library.designPrompts.difficulty')}</th>
                    <th scope="col">{t('ai.status')}</th>
                    <th scope="col">{t('library.created')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('ai.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((p) => (
                    <PromptRow
                      key={p.id}
                      prompt={p}
                      panel={panel}
                      setPanel={setPanel}
                      canManage={canManage}
                      editing={editing !== null}
                      onEdit={() => start({ key, from: p })}
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
