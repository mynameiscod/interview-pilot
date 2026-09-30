import type { ReportSummary } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { formatDate, formatMinutes, inputErrorMessage } from '../interviews/messages';
import { RecordingCard } from '../media/RecordingCard';
import { CertificatePanel } from '../progress/CertificatePanel';
import { SharePanel } from '../proof/SharePanel';
import { BenchmarkCard } from './components/BenchmarkCard';
import { AssessmentPanelView } from './components/AssessmentPanelView';
import { CodingResults } from './components/CodingResults';
import { DeliverySection } from './components/DeliverySection';
import { DimensionBars } from './components/DimensionBars';
import { FeedbackCard } from './components/FeedbackCard';
import { OverallReadiness } from './components/OverallReadiness';
import { PlanTabs } from './components/PlanTabs';
import { QuestionFeedbackList, StructureCard } from './components/QuestionFeedbackList';
import {
  NextSteps,
  ReportTranscript,
  RoundsAndCoverage,
  StrengthsAndGaps,
} from './components/ReportSections';
import { ReportTabs, type ReportTab } from './components/ReportTabs';
import { SessionObservations } from './components/SessionObservations';
import { FEEDBACK_ANCHOR, useReport } from './reports-api';

function ReportHeader({ report }: { report: ReportSummary }) {
  const { t, i18n } = useTranslation();
  const { header } = report.content;
  const when = header.endedAt ?? header.startedAt ?? report.generatedAt;
  const facts = [
    { label: t('report.header.date'), value: formatDate(i18n.resolvedLanguage, when) },
    { label: t('report.header.mode'), value: t(`setup.modes.${header.mode}.name`) },
    { label: t('report.header.duration'), value: formatMinutes(t, header.durationSec) },
    { label: t('report.header.language'), value: t(`profileForm.languages.${header.language}`) },
  ];
  return (
    <header className="mb-4">
      <p className="small cb-text-secondary mb-1">{t('report.eyebrow')}</p>
      <h1 className="h3 mb-1">{header.title}</h1>
      {header.companyName && <p className="fs-5 mb-2">{header.companyName}</p>}
      <dl className="d-flex flex-wrap gap-3 small mb-3">
        {facts.map((fact) => (
          <div key={fact.label} className="d-flex gap-1">
            <dt className="fw-normal cb-text-secondary">{fact.label}:</dt>
            <dd className="mb-0 fw-semibold">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="alert alert-info d-flex gap-2 mb-0" role="note">
        <i className="bi bi-robot" aria-hidden="true" />
        <div>
          <strong>{t('report.aiGenerated')}</strong> {report.content.disclaimer}
        </div>
      </div>
    </header>
  );
}

type Section = 'summary' | 'questions' | 'delivery' | 'plan';

/**
 * The report in sections (Summary, Questions, Delivery, Plan) as tabs, then
 * what is shared by all of them: next steps, sharing, recording, observations,
 * the transcript and feedback. Questions and Delivery appear only when the
 * report has them (older reports and typed interviews do not).
 */
function ReportView({ report }: { report: ReportSummary }) {
  const { t } = useTranslation();
  const { content } = report;
  const [section, setSection] = useState<Section>('summary');
  const tabs: ReportTab<Section>[] = [
    {
      key: 'summary',
      label: t('report.tabs.summary'),
      icon: 'bi-speedometer2',
      panel: (
        <>
          <OverallReadiness overall={content.overall} />
          {content.benchmark && <BenchmarkCard benchmark={content.benchmark} />}
          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby="summary-title"
          >
            <h2 id="summary-title" className="h5">
              {t('report.summaryTitle')}
            </h2>
            <p className="mb-0">{content.summary}</p>
          </section>
          <DimensionBars dimensions={content.dimensions} />
          <StrengthsAndGaps content={content} />
          {content.coding && content.coding.length > 0 && <CodingResults items={content.coding} />}
          {content.systemDesign && (
            <AssessmentPanelView kind="systemDesign" panel={content.systemDesign} />
          )}
          {content.aiCollaboration && (
            <AssessmentPanelView kind="aiCollaboration" panel={content.aiCollaboration} />
          )}
          <RoundsAndCoverage content={content} />
        </>
      ),
    },
  ];
  if (content.questions?.length) {
    tabs.push({
      key: 'questions',
      label: t('report.tabs.questions'),
      icon: 'bi-chat-square-text',
      panel: (
        <>
          {content.structure && <StructureCard structure={content.structure} />}
          <QuestionFeedbackList questions={content.questions} />
        </>
      ),
    });
  }
  if (content.delivery) {
    tabs.push({
      key: 'delivery',
      label: t('report.tabs.delivery'),
      icon: 'bi-mic',
      panel: <DeliverySection delivery={content.delivery} />,
    });
  }
  tabs.push({
    key: 'plan',
    label: t('report.tabs.plan'),
    icon: 'bi-list-check',
    panel: <PlanTabs plan={content.plan} />,
  });

  return (
    <div className="d-flex flex-column gap-4">
      <ReportTabs
        tabs={tabs}
        selected={section}
        onSelect={setSection}
        label={t('report.tabs.label')}
      />
      <NextSteps sessionId={report.sessionId} content={content} pdfReady={report.pdfReady} />
      <SharePanel sessionId={report.sessionId} />
      <CertificatePanel sessionId={report.sessionId} />
      <RecordingCard sessionId={report.sessionId} />
      {content.integrity && <SessionObservations integrity={content.integrity} />}
      {content.transcript && <ReportTranscript transcript={content.transcript} />}
      <FeedbackCard sessionId={report.sessionId} />
    </div>
  );
}

/** Screens 23–24: the readiness report and improvement plan. */
export function ReportPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const location = useLocation();
  const report = useReport(id);
  const loaded = Boolean(report.data);
  // `report_viewed` is recorded by the API when the report is fetched.

  // "Rate your interview" links land on the feedback card once the report has rendered.
  useEffect(() => {
    if (!loaded || location.hash.slice(1) !== FEEDBACK_ANCHOR) return;
    const target = document.getElementById(FEEDBACK_ANCHOR);
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [loaded, location.hash]);

  if (report.isPending) return <RouteLoading />;
  if (report.isError || !report.data) {
    const notReady = report.error instanceof ApiClientError && report.error.status === 404;
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{notReady ? t('report.notReady.title') : t('report.loadError')}</h1>
        <p className="cb-text-secondary">
          {notReady ? t('report.notReady.body') : inputErrorMessage(t, report.error)}
        </p>
        <div className="d-flex flex-wrap gap-2">
          {notReady && (
            <Link to={`/app/interviews/${id}/complete`} className="btn btn-primary">
              {t('report.notReady.progress')}
            </Link>
          )}
          <Link to="/app" className="btn btn-outline-primary">
            {t('interview.backToDashboard')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-5" style={{ maxWidth: '60rem' }}>
      <ReportHeader report={report.data} />
      <ReportView report={report.data} />
    </div>
  );
}
