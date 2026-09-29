import type { MatchBand, MatchReason, ResumeMatchReport, SkillMatch } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { useResumeMatch } from './resume-tools-api';

const BAND_CLASS: Record<MatchBand, string> = {
  STRONG: 'text-bg-success',
  GOOD: 'text-bg-primary',
  FAIR: 'text-bg-warning',
  WEAK: 'text-bg-danger',
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** One localized sentence per reason code. */
function reasonText(t: TFunction, r: MatchReason): string {
  const p = r.params;
  switch (r.code) {
    case 'SECTION_PRESENT':
    case 'SECTION_MISSING':
      return t(`resumeTools.match.reasons.${r.code}`, {
        section: t(`resumeTools.match.sections.${String(p.section)}`),
      });
    case 'FORMAT_RISK':
      return t(`resumeTools.match.risks.${String(p.risk)}`, p);
    case 'EXPERIENCE_UNKNOWN':
      return t(
        `resumeTools.match.reasons.EXPERIENCE_UNKNOWN_${p.reason === 'jd' ? 'jd' : 'resume'}`,
      );
    default:
      return t(`resumeTools.match.reasons.${r.code}`, p);
  }
}

function SkillRow({ m }: { m: SkillMatch }) {
  const { t } = useTranslation();
  return (
    <li className="d-flex align-items-start gap-2 mb-1">
      <i
        className={`bi ${m.matched ? 'bi-check-circle-fill text-success' : 'bi-x-circle text-danger'}`}
        aria-hidden="true"
      />
      <span>
        <span className="visually-hidden">
          {m.matched ? t('resumeTools.match.found') : t('resumeTools.match.missing')}:{' '}
        </span>
        {m.skill}
        {m.matchedAs && (
          <span className="cb-text-secondary small">
            {' '}
            {t('resumeTools.match.as', { as: m.matchedAs })}
          </span>
        )}
      </span>
    </li>
  );
}

function Report({ report }: { report: ResumeMatchReport }) {
  const { t } = useTranslation();
  const id = useId();
  const e = report.experience;
  return (
    <>
      <div className="d-flex flex-wrap align-items-center gap-3 mb-3">
        <p className="display-6 fw-semibold mb-0">
          {report.score}
          <span className="fs-6 cb-text-secondary">/100</span>
        </p>
        <span className={`badge ${BAND_CLASS[report.band]}`}>
          {t(`resumeTools.match.band.${report.band}`)}
        </span>
        {(report.usedEdits.resume || report.usedEdits.jd) && (
          <span className="small cb-text-secondary">
            <i className="bi bi-pencil me-1" aria-hidden="true" />
            {t('resumeTools.match.usedEdits')}
          </span>
        )}
      </div>

      <ul className="list-unstyled mb-4">
        {report.components.map((c) => (
          <li key={c.key} className="mb-2">
            <div className="d-flex justify-content-between small">
              <span>{t(`resumeTools.match.components.${c.key}`)}</span>
              <span>{t('resumeTools.match.points', { score: fmt(c.score), max: c.max })}</span>
            </div>
            <div
              className="progress"
              style={{ height: '0.5rem' }}
              role="progressbar"
              aria-label={t(`resumeTools.match.components.${c.key}`)}
              aria-valuemin={0}
              aria-valuemax={c.max}
              aria-valuenow={c.score}
            >
              <div className="progress-bar" style={{ width: `${(c.score / c.max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>

      <div className="row g-4">
        <div className="col-md-6">
          <h3 className="h6">{t('resumeTools.match.mustHave')}</h3>
          {report.skills.mustHave.length ? (
            <ul className="list-unstyled small">
              {report.skills.mustHave.map((m) => (
                <SkillRow key={m.skill} m={m} />
              ))}
            </ul>
          ) : (
            <p className="small cb-text-secondary">{t('resumeTools.match.noSkills')}</p>
          )}
          {report.skills.niceToHave.length > 0 && (
            <>
              <h3 className="h6">{t('resumeTools.match.niceToHave')}</h3>
              <ul className="list-unstyled small">
                {report.skills.niceToHave.map((m) => (
                  <SkillRow key={m.skill} m={m} />
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="col-md-6">
          <h3 className="h6">{t('resumeTools.match.experienceTitle')}</h3>
          <p className="small">
            {t(`resumeTools.match.fit.${e.fit}`, {
              years: e.candidateYears ?? '?',
              required: e.requiredMinYears ?? '?',
            })}
          </p>
          <h3 className="h6">{t('resumeTools.match.sectionsTitle')}</h3>
          <ul className="list-unstyled small">
            {report.sections.map((s) => (
              <li key={s.key}>
                <i
                  className={`bi ${s.present ? 'bi-check-lg text-success' : 'bi-dash-circle text-warning'} me-2`}
                  aria-hidden="true"
                />
                <span className="visually-hidden">
                  {s.present ? t('resumeTools.match.found') : t('resumeTools.match.missing')}:{' '}
                </span>
                {t(`resumeTools.match.sections.${s.key}`)}
              </li>
            ))}
          </ul>
          <h3 className="h6">{t('resumeTools.match.formattingTitle')}</h3>
          {report.formatting.some((f) => f.flagged) ? (
            <ul className="small ps-3">
              {report.reasons
                .filter((r) => r.code === 'FORMAT_RISK')
                .map((r) => (
                  <li key={String(r.params.risk)}>{reasonText(t, r)}</li>
                ))}
            </ul>
          ) : (
            <p className="small">{t('resumeTools.match.noFormattingRisks')}</p>
          )}
        </div>
      </div>

      <details className="mt-2">
        <summary className="small fw-semibold" id={`${id}-why`}>
          {t('resumeTools.match.why')}
        </summary>
        <ul className="small mt-2" aria-labelledby={`${id}-why`}>
          {report.reasons.map((r, i) => (
            <li key={`${r.code}-${i}`}>
              {reasonText(t, r)}{' '}
              {r.impact !== 'INFO' && (
                <span className="cb-text-secondary">
                  ({r.points >= 0 ? '+' : ''}
                  {fmt(r.points)})
                </span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/**
 * "Resume match": a deterministic, explainable score of the resume against
 * the job description (free; no AI). Uses the candidate's edited revisions.
 */
export function MatchPanel({
  resumeId,
  jobTargetId,
  stamp,
}: {
  resumeId: string | null;
  jobTargetId: string | null;
  /** Changes when either input is edited, so the score refreshes. */
  stamp?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const match = useResumeMatch(resumeId, jobTargetId, stamp);
  const notReady = match.error instanceof ApiClientError && match.error.code === 'INVALID_STATE';

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5">
        {t('resumeTools.match.title')}
      </h2>
      <p className="small cb-text-secondary">{t('resumeTools.match.intro')}</p>
      {!resumeId || !jobTargetId ? (
        <p className="mb-0">{t('resumeTools.match.needBoth')}</p>
      ) : match.isPending ? (
        <p className="small" role="status">
          {t('common.loading')}
        </p>
      ) : match.isError ? (
        <div className="alert alert-warning mb-0" role="alert">
          {notReady ? t('resumeTools.match.notReady') : inputErrorMessage(t, match.error)}
        </div>
      ) : (
        <Report report={match.data} />
      )}
    </section>
  );
}
