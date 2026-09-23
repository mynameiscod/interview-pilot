import { AiFeature, type PromptRole, type PromptTemplateSummary } from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { consoleError } from '../ai/format';

const STATUS_BADGE: Record<PromptTemplateSummary['status'], string> = {
  ACTIVE: 'text-bg-success',
  DRAFT: 'text-bg-info',
  RETIRED: 'text-bg-secondary',
};

type Draft = {
  key: string;
  locale: string;
  feature: AiFeature;
  messages: { role: PromptRole; content: string }[];
  notes: string;
};

const emptyDraft = (): Draft => ({
  key: '',
  locale: 'en',
  feature: 'interview.question',
  messages: [
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ],
  notes: '',
});

function NewVersion({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      manager.api.post('/admin/prompts', {
        ...draft,
        messages: draft.messages.filter((m) => m.content.trim() !== ''),
        notes: draft.notes.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['prompts'] });
      onDone();
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <form
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="h6">{t('prompts.newTitle')}</h2>
      <div className="row g-2 mb-2">
        <div className="col-md-5">
          <label htmlFor={`${id}-key`} className="form-label small">
            {t('prompts.key')}
          </label>
          <input
            id={`${id}-key`}
            className="form-control form-control-sm"
            placeholder="interview.question"
            spellCheck={false}
            value={draft.key}
            onChange={(e) => setDraft({ ...draft, key: e.target.value.trim() })}
          />
        </div>
        <div className="col-md-2">
          <label htmlFor={`${id}-locale`} className="form-label small">
            {t('prompts.locale')}
          </label>
          <input
            id={`${id}-locale`}
            className="form-control form-control-sm"
            value={draft.locale}
            onChange={(e) => setDraft({ ...draft, locale: e.target.value.trim() })}
          />
        </div>
        <div className="col-md-5">
          <label htmlFor={`${id}-feature`} className="form-label small">
            {t('prompts.feature')}
          </label>
          <select
            id={`${id}-feature`}
            className="form-select form-select-sm"
            value={draft.feature}
            onChange={(e) => setDraft({ ...draft, feature: e.target.value as AiFeature })}
          >
            {AiFeature.options
              .filter((f) => f !== 'admin.test')
              .map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
          </select>
        </div>
      </div>
      {draft.messages.map((message, index) => (
        <div className="mb-2" key={message.role}>
          <label htmlFor={`${id}-${message.role}`} className="form-label small">
            {t(`prompts.roles.${message.role}`)}
          </label>
          <textarea
            id={`${id}-${message.role}`}
            className="form-control font-monospace small"
            rows={message.role === 'system' ? 8 : 5}
            value={message.content}
            onChange={(e) => {
              const messages = [...draft.messages];
              messages[index] = { ...message, content: e.target.value };
              setDraft({ ...draft, messages });
            }}
          />
        </div>
      ))}
      <p className="small cb-text-secondary">
        {t('prompts.variablesHint', { example: '{{variable}}' })}
      </p>
      <label htmlFor={`${id}-notes`} className="form-label small">
        {t('prompts.notes')}
      </label>
      <input
        id={`${id}-notes`}
        className="form-control form-control-sm mb-2"
        value={draft.notes}
        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
      />
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={
            create.isPending ||
            draft.key.length < 3 ||
            draft.messages.every((m) => !m.content.trim())
          }
        >
          {t('prompts.saveDraft')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onDone}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

function PromptRow({
  prompt,
  canManage,
  onNewVersion,
}: {
  prompt: PromptTemplateSummary;
  canManage: boolean;
  onNewVersion: (p: PromptTemplateSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activate = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post(`/admin/prompts/${prompt.id}/activate`, { reason }),
    onSuccess: async () => {
      setActivating(false);
      await queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
    onError: (err) => setError(consoleError(t, err)),
  });
  const created = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(prompt.createdAt));

  return (
    <>
      <tr>
        <th scope="row">
          <code>{prompt.key}</code>
          <span className="small cb-text-secondary ms-2">{prompt.locale}</span>
        </th>
        <td>{t('prompts.version', { n: prompt.version })}</td>
        <td>
          <span className={`badge ${STATUS_BADGE[prompt.status]}`}>
            {t(`prompts.status.${prompt.status}`)}
          </span>
        </td>
        <td className="small">{created}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? t('prompts.hide') : t('prompts.view')}
            </button>
            {canManage && (
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                onClick={() => onNewVersion(prompt)}
              >
                {t('prompts.newVersion')}
              </button>
            )}
            {canManage && prompt.status !== 'ACTIVE' && !activating && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setActivating(true)}
              >
                {prompt.status === 'RETIRED' ? t('prompts.rollback') : t('prompts.activate')}
              </button>
            )}
          </div>
        </td>
      </tr>
      {(open || activating) && (
        <tr>
          <td colSpan={5}>
            {open && (
              <div className="mb-2">
                {prompt.messages.map((m, i) => (
                  <div key={i} className="mb-2">
                    <div className="small fw-semibold">{t(`prompts.roles.${m.role}`)}</div>
                    <pre
                      className="p-2 cb-surface-muted rounded-2 small mb-0"
                      style={{ whiteSpace: 'pre-wrap' }}
                    >
                      {m.content}
                    </pre>
                  </div>
                ))}
                <div className="small cb-text-secondary">
                  {t('prompts.variables', { list: prompt.variables.join(', ') || '—' })} ·{' '}
                  {t('prompts.hash', { hash: prompt.contentHash.slice(0, 12) })}
                  {prompt.notes && <> · {prompt.notes}</>}
                </div>
              </div>
            )}
            {activating && (
              <ReasonForm
                submitLabel={t('prompts.confirmActivate', { n: prompt.version })}
                pending={activate.isPending}
                error={error}
                onSubmit={(reason) => activate.mutate(reason)}
                onCancel={() => {
                  setActivating(false);
                  setError(null);
                }}
              >
                <p>{t('prompts.activateExplain', { key: prompt.key, n: prompt.version })}</p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function PromptsPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('prompts.manage');
  const [draft, setDraft] = useState<Draft | null>(null);
  const prompts = useQuery({
    queryKey: ['prompts'],
    queryFn: () => manager.api.get<PromptTemplateSummary[]>('/admin/prompts'),
  });

  return (
    <>
      <h1 className="h3 mb-2">{t('prompts.title')}</h1>
      <p className="cb-text-secondary">{t('prompts.subtitle')}</p>
      {canManage && !draft && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => setDraft(emptyDraft())}
        >
          {t('prompts.new')}
        </button>
      )}
      {draft && (
        <NewVersion key={draft.key || 'new'} initial={draft} onDone={() => setDraft(null)} />
      )}
      <section className="border cb-border rounded-3 bg-white" aria-label={t('prompts.title')}>
        {prompts.isPending && <LoadingRow />}
        {prompts.isError && (
          <div className="m-3">
            <ErrorAlert error={consoleError(t, prompts.error)} />
          </div>
        )}
        {prompts.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('prompts.key')}</th>
                  <th scope="col">{t('prompts.versionHeader')}</th>
                  <th scope="col">{t('ai.status')}</th>
                  <th scope="col">{t('prompts.created')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('ai.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {prompts.data.length === 0 && (
                  <tr>
                    <td colSpan={5} className="cb-text-secondary">
                      {t('prompts.empty')}
                    </td>
                  </tr>
                )}
                {prompts.data.map((p) => (
                  <PromptRow
                    key={p.id}
                    prompt={p}
                    canManage={canManage}
                    onNewVersion={(source) =>
                      setDraft({
                        key: source.key,
                        locale: source.locale,
                        feature: source.feature,
                        messages: (['system', 'user'] as const).map((role) => ({
                          role,
                          content: source.messages.find((m) => m.role === role)?.content ?? '',
                        })),
                        notes: '',
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
