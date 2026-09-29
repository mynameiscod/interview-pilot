import { effectiveResume } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useTrackOnce } from '../../lib/use-analytics';
import { useJobTargets, useResumes } from '../interviews/interviews-api';
import { formatDate } from '../interviews/messages';
import { JdPreview } from './JdPreview';
import { MatchPanel } from './MatchPanel';
import { ResumePreview } from './ResumePreview';
import { TailoringPanel } from './TailoringPanel';

/**
 * `/app/resume-check`: pick a resume and a saved job description and see the
 * match score and tailoring suggestions. No interview (and no credit) needed.
 */
export function ResumeCheckPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const resumes = useResumes();
  const jobs = useJobTargets();
  const readyResumes = (resumes.data ?? []).filter((r) => r.extraction.status === 'READY');
  const readyJobs = (jobs.data ?? []).filter(
    (j) => j.extraction.status === 'READY' && j.source !== 'ROLE_ONLY',
  );
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const resume = readyResumes.find((r) => r.id === resumeId) ?? readyResumes[0] ?? null;
  const job = readyJobs.find((j) => j.id === jobId) ?? readyJobs[0] ?? null;
  useTrackOnce('resume_match_viewed', Boolean(resume && job), { page: 'resume_check' });

  const jobLabel = (j: (typeof readyJobs)[number]) =>
    (j.edited ?? j.structured)?.title ||
    j.roleTitle ||
    j.originalName ||
    j.url ||
    t('resumeTools.check.pastedJd', { date: formatDate(i18n.resolvedLanguage, j.createdAt) });

  const loading = resumes.isPending || jobs.isPending;

  return (
    <div className="container py-5">
      <h1 className="h3">{t('resumeTools.check.title')}</h1>
      <p className="cb-text-secondary">{t('resumeTools.check.subtitle')}</p>

      {loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : readyResumes.length === 0 || readyJobs.length === 0 ? (
        <div className="p-4 border cb-border rounded-3 bg-white">
          <p>{t('resumeTools.check.needInputs')}</p>
          <Link to="/app/new" className="btn btn-primary">
            {t('resumeTools.check.addInputs')}
          </Link>
        </div>
      ) : (
        <div className="d-flex flex-column gap-4">
          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby={`${id}-pick`}
          >
            <h2 id={`${id}-pick`} className="h5">
              {t('resumeTools.check.pick')}
            </h2>
            <div className="row g-3">
              <div className="col-md-6">
                <label htmlFor={`${id}-resume`} className="form-label">
                  {t('resumeTools.check.resume')}
                </label>
                <select
                  id={`${id}-resume`}
                  className="form-select"
                  value={resume?.id ?? ''}
                  onChange={(e) => setResumeId(e.target.value)}
                >
                  {readyResumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.originalName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-md-6">
                <label htmlFor={`${id}-jd`} className="form-label">
                  {t('resumeTools.check.jd')}
                </label>
                <select
                  id={`${id}-jd`}
                  className="form-select"
                  value={job?.id ?? ''}
                  onChange={(e) => setJobId(e.target.value)}
                >
                  {readyJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {jobLabel(j)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row g-3">
              <div className="col-lg-6">{resume && <ResumePreview resume={resume} />}</div>
              <div className="col-lg-6">{job && <JdPreview target={job} />}</div>
            </div>
          </section>

          <MatchPanel
            resumeId={resume?.id ?? null}
            jobTargetId={job?.id ?? null}
            stamp={`${resume?.editedAt ?? ''}|${job?.editedAt ?? ''}`}
          />
          <TailoringPanel
            resumeId={resume?.id ?? null}
            jobTargetId={job?.id ?? null}
            resume={resume ? effectiveResume(resume) : null}
          />
        </div>
      )}
    </div>
  );
}
