import { ConsentLocale, ConsentType, type ConsentTextSummary } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../../app/session';
import { consoleError } from '../ai/format';
import { ErrorAlert, LoadingRow, ReasonForm } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { ActiveBadge } from '../library/shared';
import { ConsentTextEditor, type ConsentDraft } from './ConsentTextEditor';
import { privacyKeys, useConsentTexts } from './queries';

type Panel = { id: string; mode: 'view' | 'activate' } | null;

function VersionRow({
  text,
  panel,
  setPanel,
  canManage,
  editing,
  onEdit,
  onActivated,
}: {
  text: ConsentTextSummary;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onActivated: (text: ConsentTextSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mode = panel?.id === text.id ? panel.mode : null;
  const type = t(`privacy.consentType.${text.type}`);
  const locale = t(`privacy.locale.${text.locale}`);
  const label = t('privacy.consent.versionLabel', { type, locale, version: text.version });
  const activate = useMutation({
    mutationFn: (reason: string) =>
      manager.api.post<ConsentTextSummary>(`/admin/consent-texts/${text.id}/activate`, {
        reason,
      }),
    onSuccess: async () => {
      setError(null);
      setPanel(null);
      await queryClient.invalidateQueries({ queryKey: privacyKeys.consentTexts });
      onActivated(text);
    },
    onError: (err) => setError(consoleError(t, err)),
  });

  return (
    <>
      <tr className={text.active ? 'table-success' : undefined}>
        <th scope="row">{t('library.version', { n: text.version })}</th>
        <td>{text.title}</td>
        <td>
          <ActiveBadge active={text.active} />
        </td>
        <td className="small text-nowrap">{formatDateTime(text.createdAt, i18n.language)}</td>
        <td className="small">{text.reason ?? '—'}</td>
        <td className="text-end text-nowrap">
          <div className="d-flex flex-wrap gap-2 justify-content-end">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              aria-expanded={mode === 'view'}
              aria-label={t('privacy.consent.viewLabel', { label })}
              onClick={() => setPanel(mode === 'view' ? null : { id: text.id, mode: 'view' })}
            >
              {mode === 'view' ? t('library.hide') : t('library.view')}
            </button>
            {canManage && !editing && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  aria-label={t('privacy.consent.editLabel', { label })}
                  onClick={onEdit}
                >
                  {t('library.edit')}
                </button>
                {!text.active && mode !== 'activate' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    aria-label={t('privacy.consent.activateLabel', { label })}
                    onClick={() => {
                      setError(null);
                      setPanel({ id: text.id, mode: 'activate' });
                    }}
                  >
                    {t('library.activate')}
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
            {mode === 'view' && (
              <article className="small" aria-label={label}>
                <h4 className="h6">{text.title}</h4>
                <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
                  {text.body}
                </p>
              </article>
            )}
            {mode === 'activate' && (
              <ReasonForm
                submitLabel={t('privacy.consent.confirmActivate', { label })}
                pending={activate.isPending}
                error={error}
                onSubmit={(reason) => activate.mutate(reason)}
                onCancel={() => {
                  setPanel(null);
                  setError(null);
                }}
              >
                <ul className="small">
                  <li>
                    {t('privacy.consent.activateExplain', { version: text.version, type, locale })}
                  </li>
                  <li>{t('privacy.consent.activateReaccept')}</li>
                </ul>
              </ReasonForm>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ConsentTextsPage() {
  const { t } = useTranslation();
  const canManage = useCan('consent.manage');
  const texts = useConsentTexts();
  const [editing, setEditing] = useState<ConsentDraft | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Newest version first within each type and locale.
  const versionsOf = (type: ConsentType, locale: ConsentLocale) =>
    (texts.data ?? [])
      .filter((x) => x.type === type && x.locale === locale)
      .sort((a, b) => b.version - a.version);

  const startEditing = (next: ConsentDraft) => {
    setNotice(null);
    setPanel(null);
    setEditing(next);
  };

  return (
    <>
      <h1 className="h3 mb-2">{t('privacy.consent.title')}</h1>
      <p className="cb-text-secondary">{t('privacy.consent.subtitle')}</p>
      <div className="alert alert-warning py-2 small" role="note">
        <i className="bi bi-exclamation-triangle me-2" aria-hidden="true" />
        {t('privacy.consent.legalNote')}
      </div>
      <div role="status" aria-live="polite">
        {notice && <div className="alert alert-success py-2">{notice}</div>}
      </div>
      {canManage && editing === null && (
        <button
          type="button"
          className="btn btn-sm btn-primary mb-3"
          onClick={() =>
            startEditing({ type: 'RECORDING', locale: 'en', title: '', body: '', from: null })
          }
        >
          {t('privacy.consent.new')}
        </button>
      )}
      {editing && (
        <ConsentTextEditor
          draft={editing}
          onDone={(created) => {
            setEditing(null);
            if (created) {
              setNotice(
                t('privacy.consent.created', {
                  type: t(`privacy.consentType.${created.type}`),
                  locale: t(`privacy.locale.${created.locale}`),
                  version: created.version,
                }),
              );
            }
          }}
        />
      )}
      {texts.isPending && <LoadingRow />}
      {texts.isError && <ErrorAlert error={consoleError(t, texts.error)} />}
      {texts.data &&
        ConsentType.options.map((type) => {
          const headingId = `consent-${type}`;
          return (
            <section
              key={type}
              className="border cb-border rounded-3 bg-white mb-3 p-3"
              aria-labelledby={headingId}
            >
              <h2 id={headingId} className="h5 mb-1">
                {t(`privacy.consentType.${type}`)}
              </h2>
              <p className="small cb-text-secondary">{t(`privacy.consentTypeHint.${type}`)}</p>
              {ConsentLocale.options.map((locale) => {
                const versions = versionsOf(type, locale);
                const active = versions.find((v) => v.active);
                const groupId = `consent-${type}-${locale}`;
                const localeName = t(`privacy.locale.${locale}`);
                const typeName = t(`privacy.consentType.${type}`);
                return (
                  <section key={locale} className="mb-3" aria-labelledby={groupId}>
                    <h3 id={groupId} className="h6 mb-0">
                      {t('privacy.consent.groupHeading', { type: typeName, locale: localeName })}
                    </h3>
                    <div className="small cb-text-secondary mb-2">
                      {active
                        ? t('privacy.consent.current', {
                            version: active.version,
                            title: active.title,
                          })
                        : t('privacy.consent.noCurrent')}
                    </div>
                    {versions.length === 0 ? (
                      <p className="small cb-text-secondary mb-0">
                        {t('privacy.consent.noVersions')}
                      </p>
                    ) : (
                      <div className="table-responsive">
                        <table className="table table-sm align-middle mb-0">
                          <caption className="visually-hidden">
                            {t('privacy.consent.historyCaption', {
                              type: typeName,
                              locale: localeName,
                            })}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">{t('library.versionHeader')}</th>
                              <th scope="col">{t('privacy.consent.titleField')}</th>
                              <th scope="col">{t('ai.status')}</th>
                              <th scope="col">{t('library.created')}</th>
                              <th scope="col">{t('privacy.consent.reason')}</th>
                              <th scope="col">
                                <span className="visually-hidden">{t('ai.actions')}</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {versions.map((text) => (
                              <VersionRow
                                key={text.id}
                                text={text}
                                panel={panel}
                                setPanel={setPanel}
                                canManage={canManage}
                                editing={editing !== null}
                                onEdit={() =>
                                  startEditing({
                                    type: text.type,
                                    locale: text.locale,
                                    title: text.title,
                                    body: text.body,
                                    from: text,
                                  })
                                }
                                onActivated={(activated) =>
                                  setNotice(
                                    t('privacy.consent.activated', {
                                      type: typeName,
                                      locale: localeName,
                                      version: activated.version,
                                    }),
                                  )
                                }
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                );
              })}
            </section>
          );
        })}
    </>
  );
}
