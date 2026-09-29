import { effectiveJd, JdStructured, type JobTargetSummary } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { ChipsInput } from './ChipsInput';
import { useResumeToolsApi, useRevisionCache } from './resume-tools-api';

const SENIORITY = ['INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD'] as const;

const blank = (title: string): JdStructured => ({
  title,
  seniority: null,
  companyName: null,
  location: null,
  employmentType: null,
  domain: null,
  experienceYears: null,
  responsibilities: [],
  skills: [],
  qualifications: [],
});

function Chips({ items }: { items: string[] }) {
  const { t } = useTranslation();
  if (!items.length)
    return <p className="cb-text-secondary mb-0">{t('resumeTools.resume.none')}</p>;
  return (
    <ul className="list-unstyled d-flex flex-wrap gap-1 mb-0">
      {items.map((s) => (
        <li key={s} className="badge text-bg-light border cb-border fw-normal">
          {s}
        </li>
      ))}
    </ul>
  );
}

/**
 * The job description as read (title, seniority, must-have and nice-to-have
 * skills, responsibilities) with an Edit mode. Saved corrections become a
 * revision that analysis, the match score and tailoring prefer.
 */
export function JdPreview({ target }: { target: JobTargetSummary }) {
  const { t } = useTranslation();
  const id = useId();
  const api = useResumeToolsApi();
  const cache = useRevisionCache();
  const data = effectiveJd(target);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<JdStructured | null>(null);
  const [responsibilities, setResponsibilities] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (target.source === 'ROLE_ONLY' || target.extraction.status !== 'READY') return null;

  const must = (d: JdStructured) =>
    d.skills.filter((s) => s.importance === 'MUST').map((s) => s.name);
  const nice = (d: JdStructured) =>
    d.skills.filter((s) => s.importance === 'NICE').map((s) => s.name);

  const startEdit = () => {
    const base = data ?? blank(target.roleTitle ?? target.role?.title ?? '');
    setDraft(base);
    setResponsibilities(base.responsibilities.join('\n'));
    setError(null);
    setEditing(true);
  };

  const setSkills = (importance: 'MUST' | 'NICE', names: string[]) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            skills: [
              ...(importance === 'MUST' ? [] : d.skills.filter((s) => s.importance === 'MUST')),
              ...names.map((name) => ({ name, importance })),
              ...(importance === 'NICE' ? [] : d.skills.filter((s) => s.importance === 'NICE')),
            ],
          }
        : d,
    );

  async function save() {
    if (!draft) return;
    const parsed = JdStructured.safeParse({
      ...draft,
      responsibilities: responsibilities
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 25),
    });
    if (!parsed.success || !parsed.data.title.trim()) {
      setError(t('resumeTools.edit.invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      cache.jd(await api.saveJdRevision(target.id, parsed.data));
      setEditing(false);
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setSaving(false);
    }
  }

  async function revert() {
    setError(null);
    try {
      cache.jd(await api.revertJdRevision(target.id));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    }
  }

  return (
    <section className="border cb-border rounded-3 p-3 mt-3" aria-labelledby={`${id}-title`}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <h3 id={`${id}-title`} className="h6 mb-0">
          {t('resumeTools.jd.title')}{' '}
          <span className="badge text-bg-light border cb-border fw-normal">
            <i
              className={`bi ${target.edited ? 'bi-pencil' : 'bi-stars'} me-1`}
              aria-hidden="true"
            />
            {t(`resumeTools.resume.source.${target.edited ? 'edited' : 'ai'}`)}
          </span>
        </h3>
        {!editing && (
          <div className="d-flex gap-2">
            {target.edited && target.structured && (
              <button type="button" className="btn btn-link btn-sm" onClick={() => void revert()}>
                {t('resumeTools.edit.revert')}
              </button>
            )}
            <button type="button" className="btn btn-outline-primary btn-sm" onClick={startEdit}>
              <i className="bi bi-pencil me-1" aria-hidden="true" />
              {t('resumeTools.edit.edit')}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {editing && draft ? (
        <form
          aria-label={t('resumeTools.edit.jdFormLabel')}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="row g-2 mb-3">
            <div className="col-md-8">
              <label htmlFor={`${id}-jt`} className="form-label">
                {t('resumeTools.jd.jobTitle')}
              </label>
              <input
                id={`${id}-jt`}
                className="form-control"
                maxLength={160}
                required
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="col-md-4">
              <label htmlFor={`${id}-sen`} className="form-label">
                {t('resumeTools.jd.seniority')}
              </label>
              <select
                id={`${id}-sen`}
                className="form-select"
                value={draft.seniority ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    seniority: (e.target.value || null) as JdStructured['seniority'],
                  })
                }
              >
                <option value="">{t('resumeTools.jd.seniorityUnknown')}</option>
                {SENIORITY.map((s) => (
                  <option key={s} value={s}>
                    {t(`analysis.seniority.${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ChipsInput
            label={t('resumeTools.jd.mustHave')}
            values={must(draft)}
            maxItems={40}
            onChange={(names) => setSkills('MUST', names)}
          />
          <ChipsInput
            label={t('resumeTools.jd.niceToHave')}
            values={nice(draft)}
            maxItems={40}
            onChange={(names) => setSkills('NICE', names)}
          />
          <label htmlFor={`${id}-resp`} className="form-label">
            {t('resumeTools.jd.responsibilities')}
          </label>
          <textarea
            id={`${id}-resp`}
            className="form-control mb-1"
            rows={5}
            value={responsibilities}
            aria-describedby={`${id}-resp-hint`}
            onChange={(e) => setResponsibilities(e.target.value)}
          />
          <div id={`${id}-resp-hint`} className="form-text mb-3">
            {t('resumeTools.edit.onePerLine')}
          </div>
          <div className="d-flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('resumeTools.edit.saving') : t('resumeTools.edit.save')}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={() => setEditing(false)}
            >
              {t('resumeTools.edit.cancel')}
            </button>
          </div>
        </form>
      ) : data ? (
        <div className="small">
          <p className="mb-2">
            <span className="fw-semibold">{data.title}</span>
            {data.seniority && (
              <span className="cb-text-secondary">
                {' '}
                · {t(`analysis.seniority.${data.seniority}`)}
              </span>
            )}
          </p>
          <h4 className="h6 mt-3">{t('resumeTools.jd.mustHave')}</h4>
          <Chips items={must(data)} />
          <h4 className="h6 mt-3">{t('resumeTools.jd.niceToHave')}</h4>
          <Chips items={nice(data)} />
          {data.responsibilities.length > 0 && (
            <>
              <h4 className="h6 mt-3">{t('resumeTools.jd.responsibilities')}</h4>
              <ul className="mb-0">
                {data.responsibilities.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <p className="small mb-0">{t('resumeTools.jd.notStructured')}</p>
      )}
    </section>
  );
}
