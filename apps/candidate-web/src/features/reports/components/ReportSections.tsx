import type { ReportContent } from '@cbi/shared-types';
import type { TFunction } from 'i18next';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { track } from '../../../lib/analytics';
import { useCandidateAuth } from '../../../app/session';
import { formatDate, formatMinutes } from '../../interviews/messages';
import { DELTA_ICON, deltaText } from '../report-format';
import { downloadReportPdf, PdfNotReadyError } from '../reports-api';

type Content = ReportContent;

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="p-4 border cb-border rounded-3 bg-white h-100" aria-labelledby={id}>
      <h2 id={id} className="h5">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Screen 23 §4: hedged strengths and gaps side by side (stacked on small screens). */
export function StrengthsAndGaps({ content }: { content: Content }) {
  const { t } = useTranslation();
  const lists = [
    { key: 'strengths', items: content.strengths, icon: 'bi-hand-thumbs-up text-success' },
    { key: 'gaps', items: content.gaps, icon: 'bi-signpost-split text-warning' },
  ] as const;
  return (
    <div className="row g-4">
      {lists.map(({ key, items, icon }) => (
        <div key={key} className="col-md-6">
          <Card id={`${key}-title`} title={t(`report.${key}.title`)}>
            {items.length === 0 ? (
              <p className="cb-text-secondary mb-0">{t(`report.${key}.empty`)}</p>
            ) : (
              <ul className="list-unstyled mb-0">
                {items.map((item, index) => (
                  <li key={index} className="d-flex gap-2 mb-2">
                    <i className={`bi ${icon} mt-1`} aria-hidden="true" />
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ))}
    </div>
  );
}

const yesNo = (t: TFunction, value: boolean) => (value ? t('report.yes') : t('report.no'));

/** Screen 23 §5: what each round covered and which skills were assessed. */
export function RoundsAndCoverage({ content }: { content: Content }) {
  const { t } = useTranslation();
  return (
    <div className="row g-4">
      <div className="col-lg-5">
        <Card id="rounds-title" title={t('report.rounds.title')}>
          <div className="table-responsive">
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('report.rounds.round')}</th>
                  <th scope="col">{t('report.rounds.questions')}</th>
                  <th scope="col">{t('report.rounds.answered')}</th>
                  <th scope="col">{t('report.rounds.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {content.rounds.map((round, index) => (
                  <tr key={index}>
                    <th scope="row" className="fw-normal">
                      {t(`analysis.roundTypes.${round.type}`)}
                    </th>
                    <td>{round.questions}</td>
                    <td>{round.answered}</td>
                    <td>{formatMinutes(t, round.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <div className="col-lg-7">
        <Card id="coverage-title" title={t('report.coverage.title')}>
          {content.coverage.length === 0 ? (
            <p className="cb-text-secondary mb-0">{t('report.coverage.empty')}</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm mb-0">
                <thead>
                  <tr>
                    <th scope="col">{t('report.coverage.skill')}</th>
                    <th scope="col">{t('report.coverage.from')}</th>
                    <th scope="col">{t('report.coverage.inResume')}</th>
                    <th scope="col">{t('report.coverage.assessed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {content.coverage.map((row) => (
                    <tr key={row.skill}>
                      <th scope="row" className="fw-normal">
                        {row.skill}
                      </th>
                      <td>
                        {row.sources
                          .map((s) => t(`analysis.sources.${s}`, { defaultValue: s }))
                          .join(', ')}
                      </td>
                      <td>
                        <i
                          className={`bi ${row.inResume ? 'bi-check-lg' : 'bi-dash'} me-1`}
                          aria-hidden="true"
                        />
                        {yesNo(t, row.inResume)}
                      </td>
                      <td>
                        <i
                          className={`bi ${row.assessed ? 'bi-check-lg' : 'bi-dash'} me-1`}
                          aria-hidden="true"
                        />
                        {yesNo(t, row.assessed)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Downloads the PDF once it is rendered; until then a disabled "Preparing PDF…" button. */
export function PdfButton({ sessionId, pdfReady }: { sessionId: string; pdfReady: boolean }) {
  const { t } = useTranslation();
  const { manager } = useCandidateAuth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!pdfReady) {
    return (
      <button type="button" className="btn btn-outline-primary" disabled>
        <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        {t('report.pdf.preparing')}
      </button>
    );
  }

  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      await downloadReportPdf(manager, sessionId);
      track('report_pdf_downloaded');
    } catch (err) {
      setProblem(
        err instanceof PdfNotReadyError ? t('report.pdf.notReady') : t('report.pdf.failed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-outline-primary"
        disabled={busy}
        onClick={() => void download()}
      >
        <i className="bi bi-file-earmark-arrow-down me-2" aria-hidden="true" />
        {busy ? t('report.pdf.downloading') : t('report.pdf.download')}
      </button>
      {problem && (
        <p className="small text-danger w-100 mb-0" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/** Screen 24 §7: progress since the last attempt, retake and PDF. */
export function NextSteps({
  sessionId,
  content,
  pdfReady,
}: {
  sessionId: string;
  content: Content;
  pdfReady: boolean;
}) {
  const { t, i18n } = useTranslation();
  const previous = content.previous;
  const current = content.overall.score;
  return (
    <Card id="next-title" title={t('report.next.title')}>
      {previous && (
        <div className="mb-4">
          <h3 className="h6">{t('report.previous.title')}</h3>
          <p className="mb-2">
            {previous.overall === null
              ? t('report.previous.overallNone')
              : t('report.previous.overall', { score: previous.overall })}
            {previous.endedAt && (
              <span className="cb-text-secondary">
                {' '}
                ({formatDate(i18n.resolvedLanguage, previous.endedAt)})
              </span>
            )}
          </p>
          {previous.overall !== null && current !== null && (
            <p className="fw-semibold">
              <i
                className={`bi ${DELTA_ICON(current - previous.overall)} me-1`}
                aria-hidden="true"
              />
              {t('report.previous.overallChange', {
                change: deltaText(t, current - previous.overall),
              })}
            </p>
          )}
          {previous.deltas.length > 0 && (
            <ul className="list-unstyled mb-3">
              {previous.deltas.map((d) => (
                <li
                  key={d.key}
                  className="d-flex justify-content-between gap-2 border-bottom cb-border py-1"
                >
                  <span>{d.name}</span>
                  <span className="text-nowrap">
                    <i className={`bi ${DELTA_ICON(d.delta)} me-1`} aria-hidden="true" />
                    {deltaText(t, d.delta)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link
            to={`/app/compare?sessions=${previous.sessionId},${sessionId}`}
            className="btn btn-sm btn-outline-secondary"
          >
            {t('report.previous.compare')}
          </Link>
        </div>
      )}
      <div className="d-flex flex-wrap gap-2 align-items-center">
        <Link to="/app/new" className="btn btn-primary">
          {t('report.next.practiseAgain')}
        </Link>
        <PdfButton sessionId={sessionId} pdfReady={pdfReady} />
      </div>
    </Card>
  );
}

/** Screen 24 §8: the question-and-answer transcript, collapsed by default. */
export function ReportTranscript({
  transcript,
}: {
  transcript: NonNullable<Content['transcript']>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5 mb-0">
        <button
          type="button"
          className="btn btn-link p-0 text-decoration-none d-inline-flex align-items-center gap-2"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onClick={() => setOpen((v) => !v)}
        >
          <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} aria-hidden="true" />
          {t('report.transcript', { count: transcript.length })}
        </button>
      </h2>
      <ol id={`${id}-list`} className="list-unstyled mb-0 mt-3" hidden={!open}>
        {transcript.map((turn) => (
          <li key={turn.seq} className="mb-3 pb-3 border-bottom cb-border">
            <p className="small cb-text-secondary mb-1">
              {t(`analysis.roundTypes.${turn.roundType}`)}
            </p>
            <p className="small fw-semibold mb-1">{t('room.interviewer')}</p>
            <p className="mb-2" style={{ whiteSpace: 'pre-wrap' }}>
              {turn.question}
            </p>
            <p className="small fw-semibold mb-1">{t('room.you')}</p>
            <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
              {turn.answer ?? <span className="cb-text-secondary">{t('room.noAnswer')}</span>}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
