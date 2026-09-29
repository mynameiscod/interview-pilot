import {
  CreateCampaignBody,
  DEFAULT_INVITE_REMINDERS,
  EmployerView,
  InterviewLanguagePreference,
  type CampaignWithInvite,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ErrorAlert, LoadingRow } from '../features/ai/shared';
import { campaignError } from '../features/campaigns/format';
import { CampaignStatusBadge, InviteLinkPanel, Pager } from '../features/campaigns/shared';
import { formatDateTime } from '../features/library/format';
import { localInputToIso, optionalInt } from '../features/payments/format';
import { orgKeys, useOrganisation, useOrgCampaigns, useOrgLibrary } from './queries';
import { useOrgAuth, useOrgCan } from './session';

type FormState = {
  name: string;
  roleId: string;
  templateKey: string;
  modes: string[];
  languages: string[];
  startAt: string;
  endAt: string;
  maxCandidates: string;
  sponsoredCredits: string;
  jobDescription: string;
  candidateSeesReport: boolean;
  employerView: EmployerView;
  requireInvite: boolean;
  idCapture: boolean;
  remindersEnabled: boolean;
  reminderMax: string;
  reminderHours: string;
};

const EMPTY: FormState = {
  name: '',
  roleId: '',
  templateKey: '',
  modes: ['TEXT'],
  languages: ['auto'],
  startAt: '',
  endAt: '',
  maxCandidates: '',
  sponsoredCredits: '',
  jobDescription: '',
  candidateSeesReport: true,
  employerView: 'FULL_REPORT',
  requireInvite: false,
  idCapture: false,
  remindersEnabled: DEFAULT_INVITE_REMINDERS.enabled,
  reminderMax: String(DEFAULT_INVITE_REMINDERS.max),
  reminderHours: String(DEFAULT_INVITE_REMINDERS.intervalHours),
};

/** The API body for a form; the company is the organisation (candidates see its name). */
function toCampaignBody(form: FormState, companyName: string, now: string) {
  return {
    name: form.name.trim(),
    companyId: null,
    companyName,
    roleId: form.roleId,
    templateKey: form.templateKey,
    jobDescription: form.jobDescription.trim() || null,
    modes: form.modes,
    languages: form.languages,
    window: {
      startAt: form.startAt ? (localInputToIso(form.startAt) ?? '') : now,
      endAt: form.endAt ? (localInputToIso(form.endAt) ?? '') : null,
    },
    maxCandidates: optionalInt(form.maxCandidates),
    proctoring: { recording: 'OFF' as const, tabSwitchTracking: false },
    candidateSeesReport: form.candidateSeesReport,
    sponsoredCredits: optionalInt(form.sponsoredCredits),
    requireInvite: form.requireInvite,
    employerView: form.employerView,
    idCapture: form.idCapture,
    reminders: {
      enabled: form.remindersEnabled,
      max: Number(form.reminderMax),
      intervalHours: Number(form.reminderHours),
    },
  };
}

function OrgCampaignForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: CampaignWithInvite) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager, user } = useOrgAuth();
  const queryClient = useQueryClient();
  const library = useOrgLibrary();
  const organisation = useOrganisation();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: 'modes' | 'languages', value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));

  if (library.isPending) return <LoadingRow />;
  const template = library.data?.templates.find((tpl) => tpl.key === form.templateKey);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = CreateCampaignBody.safeParse(
      toCampaignBody(form, user?.org.name ?? '', new Date().toISOString()),
    );
    if (!parsed.success) {
      setIssues([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))]);
      return;
    }
    setIssues([]);
    setPending(true);
    try {
      const created = await manager.api.post<CampaignWithInvite>('/org/campaigns', parsed.data);
      await queryClient.invalidateQueries({ queryKey: orgKeys.all });
      onCreated(created);
    } catch (err) {
      setError(campaignError(t, err));
      setPending(false);
    }
  }

  const field = (key: string) => `${id}-${key}`;
  return (
    <form
      noValidate
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
      onSubmit={(e) => void submit(e)}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('orgPortal.campaigns.createTitle')}
      </h2>
      <ErrorAlert error={library.isError ? t('orgPortal.campaigns.libraryFailed') : null} />
      <div className="row g-2 mb-3">
        <div className="col-md-6">
          <label htmlFor={field('name')} className="form-label small">
            {t('campaigns.fields.name')}
          </label>
          <input
            id={field('name')}
            className="form-control form-control-sm"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="col-md-3">
          <label htmlFor={field('roleId')} className="form-label small">
            {t('campaigns.fields.role')}
          </label>
          <select
            id={field('roleId')}
            className="form-select form-select-sm"
            value={form.roleId}
            onChange={(e) => set('roleId', e.target.value)}
          >
            <option value="">{t('campaigns.fields.chooseRole')}</option>
            {(library.data?.roles ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </div>
        <div className="col-md-3">
          <label htmlFor={field('templateKey')} className="form-label small">
            {t('campaigns.fields.template')}
          </label>
          <select
            id={field('templateKey')}
            className="form-select form-select-sm"
            value={form.templateKey}
            onChange={(e) => {
              const tpl = library.data?.templates.find((x) => x.key === e.target.value);
              setForm((f) => ({
                ...f,
                templateKey: e.target.value,
                modes: tpl ? f.modes.filter((m) => tpl.modes.includes(m)).slice(0, 3) : f.modes,
              }));
            }}
          >
            <option value="">{t('campaigns.fields.chooseTemplate')}</option>
            {(library.data?.templates ?? []).map((tpl) => (
              <option key={tpl.key} value={tpl.key}>
                {tpl.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="col-md-6">
          <legend className="form-label small mb-1">{t('campaigns.fields.modes')}</legend>
          {['TEXT', 'VOICE', 'VIDEO'].map((mode) => (
            <div className="form-check form-check-inline" key={mode}>
              <input
                id={field(`mode-${mode}`)}
                type="checkbox"
                className="form-check-input"
                checked={form.modes.includes(mode)}
                disabled={template !== undefined && !template.modes.includes(mode)}
                onChange={() => toggle('modes', mode)}
              />
              <label htmlFor={field(`mode-${mode}`)} className="form-check-label">
                {t(`library.modes.${mode}`)}
              </label>
            </div>
          ))}
        </fieldset>
        <fieldset className="col-md-6">
          <legend className="form-label small mb-1">{t('campaigns.fields.languages')}</legend>
          {InterviewLanguagePreference.options.map((lang) => (
            <div className="form-check form-check-inline" key={lang}>
              <input
                id={field(`lang-${lang}`)}
                type="checkbox"
                className="form-check-input"
                checked={form.languages.includes(lang)}
                onChange={() => toggle('languages', lang)}
              />
              <label htmlFor={field(`lang-${lang}`)} className="form-check-label">
                {t(`campaigns.languages.${lang}`)}
              </label>
            </div>
          ))}
        </fieldset>
        {(
          [
            ['startAt', 'datetime-local', 'campaigns.fields.startAt'],
            ['endAt', 'datetime-local', 'campaigns.fields.endAt'],
            ['maxCandidates', 'number', 'campaigns.fields.maxCandidates'],
            ['sponsoredCredits', 'number', 'orgPortal.campaigns.sponsoredCredits'],
          ] as const
        ).map(([key, type, label]) => (
          <div className="col-md-3" key={key}>
            <label htmlFor={field(key)} className="form-label small">
              {t(label)}
            </label>
            <input
              id={field(key)}
              type={type}
              min={type === 'number' ? 1 : undefined}
              className="form-control form-control-sm"
              value={form[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </div>
        ))}
        <p className="col-12 small cb-text-secondary mb-0">
          {t('orgPortal.campaigns.walletHint', {
            count: organisation.data?.wallet.balance ?? 0,
          })}
        </p>
        <div className="col-md-4">
          <label htmlFor={field('employerView')} className="form-label small">
            {t('orgPortal.campaigns.employerView')}
          </label>
          <select
            id={field('employerView')}
            className="form-select form-select-sm"
            value={form.employerView}
            onChange={(e) => set('employerView', e.target.value as EmployerView)}
            aria-describedby={field('employerView-hint')}
          >
            {EmployerView.options.map((v) => (
              <option key={v} value={v}>
                {t(`orgPortal.employerView.${v}`)}
              </option>
            ))}
          </select>
          <div id={field('employerView-hint')} className="form-text">
            {t('orgPortal.campaigns.employerViewHint')}
          </div>
        </div>
        <div className="col-md-8 d-flex flex-column justify-content-end">
          {(
            [
              ['candidateSeesReport', 'campaigns.fields.candidateSeesReport'],
              ['requireInvite', 'orgPortal.campaigns.requireInvite'],
              ['idCapture', 'orgPortal.campaigns.idCapture'],
              ['remindersEnabled', 'orgPortal.campaigns.reminders'],
            ] as const
          ).map(([key, label]) => (
            <div className="form-check form-switch" key={key}>
              <input
                id={field(key)}
                type="checkbox"
                role="switch"
                className="form-check-input"
                checked={form[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
              <label htmlFor={field(key)} className="form-check-label">
                {t(label)}
              </label>
            </div>
          ))}
        </div>
        {form.remindersEnabled && (
          <>
            <div className="col-md-3">
              <label htmlFor={field('reminderMax')} className="form-label small">
                {t('orgPortal.campaigns.reminderMax')}
              </label>
              <select
                id={field('reminderMax')}
                className="form-select form-select-sm"
                value={form.reminderMax}
                onChange={(e) => set('reminderMax', e.target.value)}
              >
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </div>
            <div className="col-md-3">
              <label htmlFor={field('reminderHours')} className="form-label small">
                {t('orgPortal.campaigns.reminderHours')}
              </label>
              <input
                id={field('reminderHours')}
                type="number"
                min={12}
                className="form-control form-control-sm"
                value={form.reminderHours}
                onChange={(e) => set('reminderHours', e.target.value)}
              />
            </div>
          </>
        )}
        <div className="col-12">
          <label htmlFor={field('jobDescription')} className="form-label small">
            {t('campaigns.fields.jobDescription')}
          </label>
          <textarea
            id={field('jobDescription')}
            rows={3}
            className="form-control form-control-sm"
            value={form.jobDescription}
            onChange={(e) => set('jobDescription', e.target.value)}
          />
        </div>
      </div>
      {issues.length > 0 && (
        <div className="alert alert-warning py-2" role="alert">
          {t('orgPortal.campaigns.fixFields', { fields: issues.join(', ') })}
        </div>
      )}
      <ErrorAlert error={error} />
      <div className="d-flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>
          {t('campaigns.create.submit')}
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onCancel}>
          {t('ai.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The organisation's campaigns (the portal's home page). */
export function OrgCampaignsPage() {
  const { t, i18n } = useTranslation();
  const canManage = useOrgCan('org.campaigns.manage');
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const campaigns = useOrgCampaigns(page);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CampaignWithInvite | null>(null);

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
        <h1 className="h3 mb-0">{t('orgPortal.campaigns.title')}</h1>
        {canManage && !creating && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setCreated(null);
              setCreating(true);
            }}
          >
            <i className="bi bi-plus-lg me-1" aria-hidden="true" />
            {t('orgPortal.campaigns.new')}
          </button>
        )}
      </div>
      <p className="cb-text-secondary">{t('orgPortal.campaigns.intro')}</p>
      {created && (
        <InviteLinkPanel
          invitePath={created.invitePath}
          campaignName={created.campaign.name}
          onDismiss={() => setCreated(null)}
        >
          <Link to={`/org/campaigns/${created.campaign.id}`} className="btn btn-sm btn-primary">
            {t('orgPortal.campaigns.open')}
          </Link>
        </InviteLinkPanel>
      )}
      {creating && (
        <OrgCampaignForm
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {campaigns.isPending ? (
        <LoadingRow />
      ) : campaigns.isError ? (
        <ErrorAlert error={campaignError(t, campaigns.error)} />
      ) : campaigns.data.items.length === 0 ? (
        <p className="p-4 border cb-border rounded-3 bg-white">{t('orgPortal.campaigns.empty')}</p>
      ) : (
        <div className="table-responsive border cb-border rounded-3 bg-white">
          <table className="table table-sm align-middle mb-0">
            <caption className="visually-hidden">{t('orgPortal.campaigns.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('campaigns.fields.name')}</th>
                <th scope="col">{t('campaigns.fields.role')}</th>
                <th scope="col">{t('orgPortal.campaigns.status')}</th>
                <th scope="col">{t('orgPortal.campaigns.joined')}</th>
                <th scope="col">{t('orgPortal.campaigns.created')}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/org/campaigns/${c.id}`}>{c.name}</Link>
                    {c.requireInvite && (
                      <span className="badge text-bg-light border cb-border ms-2">
                        {t('orgPortal.campaigns.inviteOnly')}
                      </span>
                    )}
                  </td>
                  <td>{c.role.title}</td>
                  <td>
                    <CampaignStatusBadge status={c.status} />
                  </td>
                  <td>{c.joined}</td>
                  <td className="small">{formatDateTime(c.createdAt, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {campaigns.data && (
        <Pager
          page={page}
          pageSize={campaigns.data.pageSize}
          total={campaigns.data.total}
          onPage={(next) => setParams(next > 1 ? { page: String(next) } : {}, { replace: true })}
        />
      )}
    </>
  );
}
