import { CompetencyCategory, type TemplateContent, type TemplateSummary } from '@cbi/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime, libraryError, minutes } from './format';
import { StatusBadge } from './shared';
import { TemplateEditor } from './TemplateEditor';

type Editing = { key: string | null; initial: TemplateContent | null } | null;
type Panel = { id: string; mode: 'view' | 'activate' } | null;

function TemplateViewer({ template }: { template: TemplateSummary }) {
  const { t } = useTranslation();
  const c = template.content;
  const yesNo = (value: boolean) => (value ? t('library.yes') : t('library.no'));
  return (
    <article
      aria-label={t('library.templates.viewerLabel', {
        key: template.key,
        version: t('library.version', { n: template.version }),
      })}
      className="small"
    >
      {c.description && <p>{c.description}</p>}
      <div className="table-responsive">
        <table className="table table-sm">
          <caption className="caption-top">
            {t('library.templates.roundsCaption', {
              count: c.rounds.length,
              minutes: minutes(template.totalDurationSec),
            })}
          </caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('library.templates.roundType')}</th>
              <th scope="col" className="text-end">
                {t('library.templates.durationMin')}
              </th>
              <th scope="col" className="text-end">
                {t('library.templates.questions')}
              </th>
              <th scope="col">{t('library.templates.difficulty')}</th>
              <th scope="col" className="text-end">
                {t('library.templates.followUpDepth')}
              </th>
              <th scope="col" className="text-end">
                {t('library.templates.minEvidence')}
              </th>
            </tr>
          </thead>
          <tbody>
            {c.rounds.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                <td>{t(`library.roundTypes.${r.type}`)}</td>
                <td className="text-end">{minutes(r.durationSec)}</td>
                <td className="text-end">{r.questionCount}</td>
                <td>{t(`library.difficulty.${r.difficulty}`)}</td>
                <td className="text-end">{r.followUpDepth}</td>
                <td className="text-end">{r.minEvidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row g-3">
        <dl className="col-md-6 mb-0">
          <dt>{t('library.templates.modes')}</dt>
          <dd>{c.modes.map((m) => t(`library.modes.${m}`)).join(', ')}</dd>
          <dt>{t('library.templates.creditCost')}</dt>
          <dd>{c.creditCost}</dd>
          <dt>{t('library.templates.codingRequired')}</dt>
          <dd>{yesNo(c.codingRequired)}</dd>
          <dt>{t('library.templates.proctoring')}</dt>
          <dd>
            {t('library.templates.proctoringSummary', {
              recording: t(`library.recording.${c.proctoringPolicy.recording}`),
              tabs: yesNo(c.proctoringPolicy.tabSwitchTracking),
            })}
          </dd>
          <dt>{t('library.templates.report')}</dt>
          <dd>
            {t('library.templates.reportSummary', {
              scores: yesNo(c.reportPolicy.showDimensionScores),
              transcript: yesNo(c.reportPolicy.showTranscript),
            })}
          </dd>
        </dl>
        <div className="col-md-6">
          <table className="table table-sm mb-0">
            <caption className="caption-top">{t('library.templates.weights')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('library.blueprints.category')}</th>
                <th scope="col" className="text-end">
                  {t('library.blueprints.weight')}
                </th>
              </tr>
            </thead>
            <tbody>
              {CompetencyCategory.options.map((cat) => (
                <tr key={cat}>
                  <th scope="row" className="fw-normal">
                    {t(`library.categories.${cat}`)}
                  </th>
                  <td className="text-end">{c.scoringPolicy.dimensionWeights[cat] ?? 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </article>
  );
}

function TemplateRow({
  template,
  panel,
  setPanel,
  canManage,
  editing,
  onActivated,
}: {
  template: TemplateSummary;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onActivated: (template: TemplateSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === template.id ? panel.mode : null;
  const versionLabel = t('library.version', { n: template.version });
  const label = `${template.key} ${versionLabel}`;
  const activate = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<TemplateSummary>(`/admin/templates/${template.id}/activate`, { reason }),
    onSuccess: async () => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: ['library', 'templates'] });
      onActivated(template);
    },
    onError: (err) => setError(libraryError(t, err)),
  });

  return (
    <>
      <tr>
        <th scope="row">{versionLabel}</th>
        <td>{template.content.name}</td>
        <td>
          <StatusBadge status={template.status} />
        </td>
        <td className="text-end">
          {t('library.templates.minutes', { minutes: minutes(template.totalDurationSec) })}
        </td>
        <td className="text-end">{template.content.creditCost}</td>
        <td className="small">{formatDateTime(template.createdAt, i18n.language)}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('library.templates.viewLabel', { label })}
              onClick={() => setPanel(mode === 'view' ? null : { id: template.id, mode: 'view' })}
            >
              {mode === 'view' ? t('library.hide') : t('library.view')}
            </button>
            {canManage && !editing && template.status !== 'ACTIVE' && mode !== 'activate' && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                aria-label={t(
                  template.status === 'RETIRED' ? 'library.rollbackLabel' : 'library.activateLabel',
                  { version: label },
                )}
                onClick={() => {
                  setError(null);
                  setPanel({ id: template.id, mode: 'activate' });
                }}
              >
                {template.status === 'RETIRED' ? t('library.rollback') : t('library.activate')}
              </button>
            )}
          </div>
        </td>
      </tr>
      {mode && (
        <tr>
          <td colSpan={7}>
            {mode === 'view' && <TemplateViewer template={template} />}
            {mode === 'activate' && (
              <ReasonForm
                submitLabel={t('library.confirmActivate', { version: versionLabel })}
                pending={activate.isPending}
                error={error}
                onSubmit={(reason) => activate.mutate(reason)}
                onCancel={() => {
                  setPanel(null);
                  setError(null);
                }}
              >
                <p>
                  {t('library.templates.activateExplain', {
                    version: versionLabel,
                    key: template.key,
                  })}
                </p>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function TemplatesPage() {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const canManage = useCan('library.manage');
  const [editing, setEditing] = useState<Editing>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['library', 'templates'],
    queryFn: () => manager.api.get<TemplateSummary[]>('/admin/templates'),
  });

  const groups = new Map<string, TemplateSummary[]>();
  for (const tpl of templates.data ?? []) {
    groups.set(tpl.key, [...(groups.get(tpl.key) ?? []), tpl]);
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
      <h1 className="h3 mb-2">{t('library.templates.title')}</h1>
      <p className="cb-text-secondary">{t('library.templates.subtitle')}</p>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() => startEditing({ key: null, initial: null })}
        >
          {t('library.templates.new')}
        </button>
      )}
      {editing && (
        <TemplateEditor
          templateKey={editing.key}
          initial={editing.initial}
          onDone={(created) => {
            setEditing(null);
            if (created) {
              setNotice(
                t('library.templates.saved', {
                  key: created.key,
                  version: t('library.version', { n: created.version }),
                }),
              );
              setPanel({ id: created.id, mode: 'view' });
            }
          }}
        />
      )}
      {templates.isPending && <LoadingRow />}
      {templates.isError && <ErrorAlert error={libraryError(t, templates.error)} />}
      {templates.data && templates.data.length === 0 && (
        <p className="cb-text-secondary">{t('library.templates.empty')}</p>
      )}
      {sortedKeys.map((key) => {
        const versions = groups.get(key)!;
        const active = versions.find((v) => v.status === 'ACTIVE');
        const headingId = `template-${key}`;
        return (
          <section
            key={key}
            className="border cb-border rounded-3 bg-white mb-3"
            aria-labelledby={headingId}
          >
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 p-3 pb-2">
              <div>
                <h2 id={headingId} className="h6 mb-0">
                  <code>{key}</code>
                </h2>
                <div className="small cb-text-secondary">
                  {active
                    ? t('library.templates.activeSummary', {
                        name: active.content.name,
                        version: t('library.version', { n: active.version }),
                      })
                    : t('library.templates.noActive')}
                </div>
              </div>
              {canManage && editing === null && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  aria-label={t('library.templates.newVersionLabel', { key })}
                  onClick={() => startEditing({ key, initial: (active ?? versions[0]!).content })}
                >
                  {t('library.newVersion')}
                </button>
              )}
            </div>
            <div className="table-responsive">
              <table className="table align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">{t('library.versionHeader')}</th>
                    <th scope="col">{t('library.templates.name')}</th>
                    <th scope="col">{t('ai.status')}</th>
                    <th scope="col" className="text-end">
                      {t('library.templates.duration')}
                    </th>
                    <th scope="col" className="text-end">
                      {t('library.templates.creditCost')}
                    </th>
                    <th scope="col">{t('library.created')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('ai.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((tpl) => (
                    <TemplateRow
                      key={tpl.id}
                      template={tpl}
                      panel={panel}
                      setPanel={setPanel}
                      canManage={canManage}
                      editing={editing !== null}
                      onActivated={(activated) =>
                        setNotice(
                          t('library.templates.activated', {
                            key: activated.key,
                            version: t('library.version', { n: activated.version }),
                          }),
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
