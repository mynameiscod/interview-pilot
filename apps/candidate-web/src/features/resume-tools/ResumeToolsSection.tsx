import { effectiveResume, type InterviewSummary } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useTrackOnce } from '../../lib/use-analytics';
import { useJobTarget, useResumes } from '../interviews/interviews-api';
import { JdPreview } from './JdPreview';
import { MatchPanel } from './MatchPanel';
import { TailoringPanel } from './TailoringPanel';

const TRACK_PROPS = { page: 'analysis' };

/**
 * The wizard's analysis step: the job description as read (editable), the
 * resume match score and tailoring suggestions for this interview's inputs.
 * Needs a resume and a job description (not a role only).
 */
export function ResumeToolsSection({ interview }: { interview: InterviewSummary }) {
  const { t } = useTranslation();
  const target = useJobTarget(interview.jobTargetId);
  const resumes = useResumes();
  const resume = resumes.data?.find((r) => r.id === interview.resumeId) ?? null;
  const jd = target.data;
  const usable = Boolean(resume && jd && jd.source !== 'ROLE_ONLY');
  useTrackOnce('resume_match_viewed', usable, TRACK_PROPS);

  if (!interview.resumeId || !jd || jd.source === 'ROLE_ONLY') {
    if (!jd) return null;
    return (
      <p className="small cb-text-secondary mt-4 mb-0">
        {t('resumeTools.section.needBoth')}{' '}
        <Link to="/app/resume-check">{t('resumeTools.section.openCheck')}</Link>
      </p>
    );
  }

  return (
    <div className="d-flex flex-column gap-4 mt-4">
      <section className="p-4 border cb-border rounded-3 bg-white">
        <p className="small cb-text-secondary mb-0">{t('resumeTools.section.editNote')}</p>
        <JdPreview target={jd} />
      </section>
      <MatchPanel
        resumeId={interview.resumeId}
        jobTargetId={jd.id}
        stamp={`${resume?.editedAt ?? ''}|${jd.editedAt ?? ''}`}
      />
      <TailoringPanel
        resumeId={interview.resumeId}
        jobTargetId={jd.id}
        resume={resume ? effectiveResume(resume) : null}
      />
    </div>
  );
}
