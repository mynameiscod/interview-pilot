import type { LegalInfo } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../interviews/messages';
import { useLegalInfo } from '../privacy/privacy-api';
import { LEGAL_PATHS, type LegalDoc } from './legal-paths';

interface Section {
  heading: string;
  paragraphs: string[];
  points: string[];
}

/** Figures quoted by the texts, from the server (defaults until it answers). */
function textValues(info: LegalInfo | undefined, notSet: string) {
  const officer = info?.grievanceOfficer;
  return {
    officerName: officer?.name ?? notSet,
    officerEmail: officer?.email ?? notSet,
    officerAddress: officer?.address ?? notSet,
    recordingRetentionDays: info?.recordingRetentionDays ?? 90,
    deletionGraceDays: info?.deletionGraceDays ?? 7,
  };
}

/** Shown until the texts are signed off (LEGAL_DRAFT_BANNER on the API). */
export function DraftBanner({ info }: { info: LegalInfo | undefined }) {
  const { t } = useTranslation();
  // While loading, show it: a draft must never look final.
  if (info && !info.draft) return null;
  return (
    <div className="alert alert-warning d-flex gap-2" role="note">
      <i className="bi bi-exclamation-triangle" aria-hidden="true" />
      <div>
        <strong>{t('legal.draftTitle')}</strong> {t('legal.draftBody')}
      </div>
    </div>
  );
}

/** The Grievance Officer's contact details, from server configuration only. */
export function GrievanceOfficerCard({ info }: { info: LegalInfo | undefined }) {
  const { t } = useTranslation();
  const officer = info?.grievanceOfficer;
  const configured = Boolean(officer?.name || officer?.email || officer?.address);
  return (
    <section
      className="p-4 border cb-border rounded-3 cb-surface-muted"
      aria-labelledby="officer-title"
    >
      <h2 id="officer-title" className="h5">
        <i className="bi bi-person-badge me-2" aria-hidden="true" />
        {t('legal.officerTitle')}
      </h2>
      {!info ? (
        <p className="small mb-0">{t('common.loading')}</p>
      ) : configured ? (
        <dl className="row mb-0 small">
          {officer?.name && (
            <>
              <dt className="col-sm-3">{t('legal.officerName')}</dt>
              <dd className="col-sm-9">{officer.name}</dd>
            </>
          )}
          {officer?.email && (
            <>
              <dt className="col-sm-3">{t('legal.officerEmail')}</dt>
              <dd className="col-sm-9">
                <a href={`mailto:${officer.email}`}>{officer.email}</a>
              </dd>
            </>
          )}
          {officer?.address && (
            <>
              <dt className="col-sm-3">{t('legal.officerAddress')}</dt>
              <dd className="col-sm-9 mb-0" style={{ whiteSpace: 'pre-line' }}>
                {officer.address}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="small mb-0">{t('legal.officerNotConfigured')}</p>
      )}
    </section>
  );
}

/** Links to the other legal pages (footer, privacy page). */
export function LegalLinks({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <ul className={`list-inline mb-0 ${className}`}>
      {(Object.keys(LEGAL_PATHS) as LegalDoc[]).map((doc) => (
        <li key={doc} className="list-inline-item">
          <Link to={LEGAL_PATHS[doc]}>{t(`legal.links.${doc}`)}</Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Terms of Use, Privacy Notice, Grievance Redressal and How AI scoring works.
 * The texts live in locales/<lng>/legal.json; operator details and retention
 * periods are interpolated from `GET /legal`.
 */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  const { t, i18n } = useTranslation();
  const legal = useLegalInfo();
  const info = legal.data;
  const values = textValues(info, t('legal.notSet'));
  const sections = t(`${doc}.sections`, {
    ns: 'legal',
    returnObjects: true,
    ...values,
  }) as Section[];
  const showOfficer = doc === 'privacy' || doc === 'grievance' || doc === 'terms';

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <article className="col-lg-9" aria-labelledby="legal-title">
          <DraftBanner info={info} />
          <h1 id="legal-title" className="h2 mb-2">
            {t(`${doc}.title`, { ns: 'legal' })}
          </h1>
          {info?.lastUpdated && (
            <p className="small cb-text-secondary">
              {t('legal.lastUpdated', {
                date: formatDate(i18n.resolvedLanguage, `${info.lastUpdated}T00:00:00Z`),
              })}
            </p>
          )}
          <p className="lead">{t(`${doc}.summary`, { ns: 'legal', ...values })}</p>

          <nav className="p-3 border cb-border rounded-3 bg-white my-4" aria-labelledby="toc-title">
            <h2 id="toc-title" className="h6">
              {t('legal.contents')}
            </h2>
            <ol className="mb-0 small">
              {sections.map((section, index) => (
                <li key={section.heading}>
                  <a href={`#section-${index + 1}`}>{section.heading}</a>
                </li>
              ))}
            </ol>
          </nav>

          {sections.map((section, index) => (
            <section
              key={section.heading}
              id={`section-${index + 1}`}
              className="mb-4"
              aria-labelledby={`section-${index + 1}-title`}
            >
              <h2 id={`section-${index + 1}-title`} className="h5">
                {index + 1}. {section.heading}
              </h2>
              {section.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {section.points.length > 0 && (
                <ul>
                  {section.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          {showOfficer && <GrievanceOfficerCard info={info} />}

          <nav className="mt-4 small" aria-label={t('legal.otherPages')}>
            <LegalLinks />
          </nav>
        </article>
      </div>
    </div>
  );
}

export const TermsPage = () => <LegalPage doc="terms" />;
export const PrivacyPolicyPage = () => <LegalPage doc="privacy" />;
export const GrievancePage = () => <LegalPage doc="grievance" />;
export const ScoringPage = () => <LegalPage doc="scoring" />;
