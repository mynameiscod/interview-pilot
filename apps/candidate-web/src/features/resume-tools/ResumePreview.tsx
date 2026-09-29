import { effectiveResume, ResumeStructured, type ResumeSummary } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { ChipsInput } from './ChipsInput';
import { useResumeToolsApi, useRevisionCache } from './resume-tools-api';

type Experience = ResumeStructured['experience'][number];
type Education = ResumeStructured['education'][number];
type Project = ResumeStructured['projects'][number];

const EMPTY: ResumeStructured = {
  headline: null,
  totalExperienceYears: null,
  skills: [],
  experience: [],
  projects: [],
  education: [],
  certifications: [],
};

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function SourceBadge({ resume }: { resume: ResumeSummary }) {
  const { t } = useTranslation();
  const key = resume.edited ? 'edited' : resume.format === 'LINKEDIN' ? 'linkedin' : 'ai';
  return (
    <span className="badge text-bg-light border cb-border fw-normal">
      <i
        className={`bi ${key === 'edited' ? 'bi-pencil' : key === 'linkedin' ? 'bi-linkedin' : 'bi-stars'} me-1`}
        aria-hidden="true"
      />
      {t(`resumeTools.resume.source.${key}`)}
    </span>
  );
}

function ResumeView({ data }: { data: ResumeStructured }) {
  const { t } = useTranslation();
  const range = (e: Experience) =>
    [e.start ?? '?', e.current ? t('resumeTools.resume.present') : (e.end ?? '?')].join(' – ');
  return (
    <div className="small">
      {(data.headline || data.totalExperienceYears !== null) && (
        <p className="mb-2">
          {data.headline && <span className="fw-semibold">{data.headline}</span>}
          {data.totalExperienceYears !== null && (
            <span className="cb-text-secondary">
              {data.headline ? ' · ' : ''}
              {t('resumeTools.resume.years', { count: data.totalExperienceYears })}
            </span>
          )}
        </p>
      )}
      <h4 className="h6 mt-3">{t('resumeTools.resume.skills')}</h4>
      {data.skills.length ? (
        <ul className="list-unstyled d-flex flex-wrap gap-1 mb-0">
          {data.skills.map((s) => (
            <li key={s.name} className="badge text-bg-light border cb-border fw-normal">
              {s.name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cb-text-secondary mb-0">{t('resumeTools.resume.none')}</p>
      )}
      <h4 className="h6 mt-3">{t('resumeTools.resume.experience')}</h4>
      {data.experience.length ? (
        <ul className="list-unstyled mb-0">
          {data.experience.map((e, i) => (
            <li key={`${e.title}-${i}`} className="mb-2">
              <span className="fw-semibold">{e.title}</span>
              {e.organization && <span> · {e.organization}</span>}
              <span className="cb-text-secondary"> ({range(e)})</span>
              {e.highlights.length > 0 && (
                <ul className="mb-0">
                  {e.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cb-text-secondary mb-0">{t('resumeTools.resume.none')}</p>
      )}
      <h4 className="h6 mt-3">{t('resumeTools.resume.education')}</h4>
      {data.education.length ? (
        <ul className="mb-0">
          {data.education.map((e, i) => (
            <li key={`${e.qualification}-${i}`}>
              {[e.qualification, e.institution, e.year].filter(Boolean).join(', ')}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cb-text-secondary mb-0">{t('resumeTools.resume.none')}</p>
      )}
      {data.projects.length > 0 && (
        <>
          <h4 className="h6 mt-3">{t('resumeTools.resume.projects')}</h4>
          <ul className="mb-0">
            {data.projects.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <span className="fw-semibold">{p.name}</span>
                {p.summary && <span>: {p.summary}</span>}
                {p.technologies.length > 0 && (
                  <span className="cb-text-secondary"> ({p.technologies.join(', ')})</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Form state: text fields as strings, converted back on save. */
interface ExperienceDraft {
  title: string;
  organization: string;
  start: string;
  end: string;
  current: boolean;
  highlights: string;
}

const toDraft = (e: Experience): ExperienceDraft => ({
  title: e.title,
  organization: e.organization ?? '',
  start: e.start ?? '',
  end: e.end ?? '',
  current: e.current,
  highlights: e.highlights.join('\n'),
});

function ResumeEditor({
  resume,
  initial,
  onDone,
}: {
  resume: ResumeSummary;
  initial: ResumeStructured;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const api = useResumeToolsApi();
  const cache = useRevisionCache();
  const [headline, setHeadline] = useState(initial.headline ?? '');
  const [years, setYears] = useState(
    initial.totalExperienceYears === null ? '' : String(initial.totalExperienceYears),
  );
  const [skills, setSkills] = useState(initial.skills.map((s) => s.name));
  const [experience, setExperience] = useState(initial.experience.map(toDraft));
  const [education, setEducation] = useState<
    { qualification: string; institution: string; year: string }[]
  >(
    initial.education.map((e) => ({
      qualification: e.qualification,
      institution: e.institution ?? '',
      year: e.year === null ? '' : String(e.year),
    })),
  );
  const [projects, setProjects] = useState<
    { name: string; summary: string; technologies: string[] }[]
  >(
    initial.projects.map((p) => ({
      name: p.name,
      summary: p.summary ?? '',
      technologies: p.technologies,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = (): ResumeStructured => {
    const byName = new Map(initial.skills.map((s) => [s.name.toLowerCase(), s]));
    return {
      ...initial,
      headline: orNull(headline),
      totalExperienceYears: years.trim() === '' ? null : Number(years),
      skills: skills.map(
        (name) => byName.get(name.toLowerCase()) ?? { name, level: null, evidence: null },
      ),
      experience: experience
        .filter((e) => e.title.trim())
        .map((e): Experience => ({
          title: e.title.trim(),
          organization: orNull(e.organization),
          start: orNull(e.start),
          end: e.current ? null : orNull(e.end),
          current: e.current,
          highlights: lines(e.highlights).slice(0, 8),
        })),
      education: education
        .filter((e) => e.qualification.trim())
        .map((e): Education => ({
          qualification: e.qualification.trim(),
          institution: orNull(e.institution),
          year: e.year.trim() ? Number(e.year) : null,
        })),
      projects: projects
        .filter((p) => p.name.trim())
        .map((p): Project => ({
          name: p.name.trim(),
          summary: orNull(p.summary),
          technologies: p.technologies.slice(0, 15),
        })),
    };
  };

  async function save() {
    const parsed = ResumeStructured.safeParse(build());
    if (!parsed.success) {
      setError(t('resumeTools.edit.invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      cache.resume(await api.saveResumeRevision(resume.id, parsed.data));
      onDone();
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setSaving(false);
    }
  }

  const setExp = (i: number, patch: Partial<ExperienceDraft>) =>
    setExperience((list) => list.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-label={t('resumeTools.edit.resumeFormLabel')}
    >
      <div className="row g-2 mb-3">
        <div className="col-md-8">
          <label htmlFor={`${id}-headline`} className="form-label">
            {t('resumeTools.resume.headline')}
          </label>
          <input
            id={`${id}-headline`}
            className="form-control"
            maxLength={200}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </div>
        <div className="col-md-4">
          <label htmlFor={`${id}-years`} className="form-label">
            {t('resumeTools.resume.totalYears')}
          </label>
          <input
            id={`${id}-years`}
            type="number"
            min={0}
            max={60}
            step={0.5}
            className="form-control"
            value={years}
            onChange={(e) => setYears(e.target.value)}
          />
        </div>
      </div>

      <ChipsInput
        label={t('resumeTools.resume.skills')}
        values={skills}
        onChange={setSkills}
        maxItems={60}
      />

      <fieldset className="mb-3">
        <legend className="h6">{t('resumeTools.resume.experience')}</legend>
        {experience.map((e, i) => (
          <div key={i} className="border cb-border rounded-2 p-2 mb-2">
            <div className="row g-2">
              <div className="col-md-6">
                <label className="form-label small" htmlFor={`${id}-exp-${i}-title`}>
                  {t('resumeTools.edit.title')}
                </label>
                <input
                  id={`${id}-exp-${i}-title`}
                  className="form-control form-control-sm"
                  maxLength={120}
                  value={e.title}
                  onChange={(ev) => setExp(i, { title: ev.target.value })}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label small" htmlFor={`${id}-exp-${i}-org`}>
                  {t('resumeTools.edit.organization')}
                </label>
                <input
                  id={`${id}-exp-${i}-org`}
                  className="form-control form-control-sm"
                  maxLength={120}
                  value={e.organization}
                  onChange={(ev) => setExp(i, { organization: ev.target.value })}
                />
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small" htmlFor={`${id}-exp-${i}-start`}>
                  {t('resumeTools.edit.start')}
                </label>
                <input
                  id={`${id}-exp-${i}-start`}
                  className="form-control form-control-sm"
                  placeholder="2022-06"
                  pattern="\d{4}(-\d{2})?"
                  value={e.start}
                  onChange={(ev) => setExp(i, { start: ev.target.value })}
                />
              </div>
              <div className="col-6 col-md-4">
                <label className="form-label small" htmlFor={`${id}-exp-${i}-end`}>
                  {t('resumeTools.edit.end')}
                </label>
                <input
                  id={`${id}-exp-${i}-end`}
                  className="form-control form-control-sm"
                  placeholder="2024-03"
                  pattern="\d{4}(-\d{2})?"
                  value={e.current ? '' : e.end}
                  disabled={e.current}
                  onChange={(ev) => setExp(i, { end: ev.target.value })}
                />
              </div>
              <div className="col-md-4 d-flex align-items-end">
                <div className="form-check mb-1">
                  <input
                    id={`${id}-exp-${i}-current`}
                    type="checkbox"
                    className="form-check-input"
                    checked={e.current}
                    onChange={(ev) => setExp(i, { current: ev.target.checked })}
                  />
                  <label className="form-check-label small" htmlFor={`${id}-exp-${i}-current`}>
                    {t('resumeTools.edit.current')}
                  </label>
                </div>
              </div>
              <div className="col-12">
                <label className="form-label small" htmlFor={`${id}-exp-${i}-hl`}>
                  {t('resumeTools.edit.highlights')}
                </label>
                <textarea
                  id={`${id}-exp-${i}-hl`}
                  className="form-control form-control-sm"
                  rows={3}
                  value={e.highlights}
                  onChange={(ev) => setExp(i, { highlights: ev.target.value })}
                />
              </div>
            </div>
            <button
              type="button"
              className="btn btn-link btn-sm text-danger px-0"
              onClick={() => setExperience((list) => list.filter((_, j) => j !== i))}
            >
              {t('resumeTools.edit.removeEntry')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          disabled={experience.length >= 20}
          onClick={() =>
            setExperience((list) => [
              ...list,
              { title: '', organization: '', start: '', end: '', current: false, highlights: '' },
            ])
          }
        >
          <i className="bi bi-plus-lg me-1" aria-hidden="true" />
          {t('resumeTools.edit.addExperience')}
        </button>
      </fieldset>

      <fieldset className="mb-3">
        <legend className="h6">{t('resumeTools.resume.education')}</legend>
        {education.map((e, i) => (
          <div key={i} className="row g-2 mb-2 align-items-end">
            <div className="col-md-5">
              <label className="form-label small" htmlFor={`${id}-edu-${i}-q`}>
                {t('resumeTools.edit.qualification')}
              </label>
              <input
                id={`${id}-edu-${i}-q`}
                className="form-control form-control-sm"
                maxLength={160}
                value={e.qualification}
                onChange={(ev) =>
                  setEducation((l) =>
                    l.map((x, j) => (j === i ? { ...x, qualification: ev.target.value } : x)),
                  )
                }
              />
            </div>
            <div className="col-md-4">
              <label className="form-label small" htmlFor={`${id}-edu-${i}-i`}>
                {t('resumeTools.edit.institution')}
              </label>
              <input
                id={`${id}-edu-${i}-i`}
                className="form-control form-control-sm"
                maxLength={160}
                value={e.institution}
                onChange={(ev) =>
                  setEducation((l) =>
                    l.map((x, j) => (j === i ? { ...x, institution: ev.target.value } : x)),
                  )
                }
              />
            </div>
            <div className="col-6 col-md-2">
              <label className="form-label small" htmlFor={`${id}-edu-${i}-y`}>
                {t('resumeTools.edit.year')}
              </label>
              <input
                id={`${id}-edu-${i}-y`}
                type="number"
                min={1950}
                max={2100}
                className="form-control form-control-sm"
                value={e.year}
                onChange={(ev) =>
                  setEducation((l) =>
                    l.map((x, j) => (j === i ? { ...x, year: ev.target.value } : x)),
                  )
                }
              />
            </div>
            <div className="col-6 col-md-1">
              <button
                type="button"
                className="btn btn-outline-danger btn-sm"
                aria-label={t('resumeTools.edit.removeEntry')}
                onClick={() => setEducation((l) => l.filter((_, j) => j !== i))}
              >
                <i className="bi bi-trash" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          disabled={education.length >= 10}
          onClick={() =>
            setEducation((l) => [...l, { qualification: '', institution: '', year: '' }])
          }
        >
          <i className="bi bi-plus-lg me-1" aria-hidden="true" />
          {t('resumeTools.edit.addEducation')}
        </button>
      </fieldset>

      <fieldset className="mb-3">
        <legend className="h6">{t('resumeTools.resume.projects')}</legend>
        {projects.map((p, i) => (
          <div key={i} className="border cb-border rounded-2 p-2 mb-2">
            <label className="form-label small" htmlFor={`${id}-prj-${i}-n`}>
              {t('resumeTools.edit.projectName')}
            </label>
            <input
              id={`${id}-prj-${i}-n`}
              className="form-control form-control-sm mb-2"
              maxLength={120}
              value={p.name}
              onChange={(ev) =>
                setProjects((l) => l.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))
              }
            />
            <label className="form-label small" htmlFor={`${id}-prj-${i}-s`}>
              {t('resumeTools.edit.projectSummary')}
            </label>
            <textarea
              id={`${id}-prj-${i}-s`}
              className="form-control form-control-sm mb-2"
              rows={2}
              maxLength={400}
              value={p.summary}
              onChange={(ev) =>
                setProjects((l) =>
                  l.map((x, j) => (j === i ? { ...x, summary: ev.target.value } : x)),
                )
              }
            />
            <ChipsInput
              label={t('resumeTools.edit.technologies')}
              values={p.technologies}
              maxLength={60}
              maxItems={15}
              onChange={(technologies) =>
                setProjects((l) => l.map((x, j) => (j === i ? { ...x, technologies } : x)))
              }
            />
            <button
              type="button"
              className="btn btn-link btn-sm text-danger px-0"
              onClick={() => setProjects((l) => l.filter((_, j) => j !== i))}
            >
              {t('resumeTools.edit.removeEntry')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          disabled={projects.length >= 15}
          onClick={() => setProjects((l) => [...l, { name: '', summary: '', technologies: [] }])}
        >
          <i className="bi bi-plus-lg me-1" aria-hidden="true" />
          {t('resumeTools.edit.addProject')}
        </button>
      </fieldset>

      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('resumeTools.edit.saving') : t('resumeTools.edit.save')}
        </button>
        <button type="button" className="btn btn-outline-secondary" onClick={onDone}>
          {t('resumeTools.edit.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * The structured resume as the AI (or the LinkedIn parser) read it, with an
 * Edit mode. Saved corrections become a revision that analysis, the match
 * score and tailoring prefer; "Use the AI version" discards them.
 */
export function ResumePreview({ resume }: { resume: ResumeSummary }) {
  const { t } = useTranslation();
  const api = useResumeToolsApi();
  const cache = useRevisionCache();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = effectiveResume(resume);
  const headingId = useId();

  if (resume.extraction.status !== 'READY') return null;

  async function revert() {
    setError(null);
    try {
      cache.resume(await api.revertResumeRevision(resume.id));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    }
  }

  return (
    <section className="border cb-border rounded-3 p-3 mt-3" aria-labelledby={headingId}>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <h3 id={headingId} className="h6 mb-0">
          {t('resumeTools.resume.title')} <SourceBadge resume={resume} />
        </h3>
        {!editing && (
          <div className="d-flex gap-2">
            {resume.edited && resume.structured && (
              <button type="button" className="btn btn-link btn-sm" onClick={() => void revert()}>
                {t('resumeTools.edit.revert')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-outline-primary btn-sm"
              onClick={() => setEditing(true)}
            >
              <i className="bi bi-pencil me-1" aria-hidden="true" />
              {t('resumeTools.edit.edit')}
            </button>
          </div>
        )}
      </div>
      <p className="small cb-text-secondary">{t('resumeTools.resume.hint')}</p>
      {error && (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      )}
      {editing ? (
        <ResumeEditor resume={resume} initial={data ?? EMPTY} onDone={() => setEditing(false)} />
      ) : data ? (
        <ResumeView data={data} />
      ) : (
        <p className="small mb-0">{t('resumeTools.resume.notStructured')}</p>
      )}
    </section>
  );
}
