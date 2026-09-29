import type { CoachingVerdict, QuestionFeedback, StructureInsight } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StarBar } from './StarBar';

const VERDICT_STYLE: Record<CoachingVerdict, { icon: string; badge: string }> = {
  STRONG: { icon: 'bi-check-circle-fill', badge: 'text-bg-success' },
  ADEQUATE: { icon: 'bi-circle-half', badge: 'text-bg-info' },
  WEAK: { icon: 'bi-exclamation-circle', badge: 'text-bg-warning' },
  UNASSESSED: { icon: 'bi-dash-circle', badge: 'text-bg-light border cb-border' },
};

/** "Most often missing" across the behavioural answers, with a tip for that part. */
export function StructureCard({ structure }: { structure: StructureInsight }) {
  const { t } = useTranslation();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="structure-title">
      <h2 id="structure-title" className="h5">
        {t('report.structure.title')}
      </h2>
      <p className="mb-2">
        {t('report.structure.complete', {
          complete: structure.complete,
          total: structure.behaviouralAnswers,
        })}
      </p>
      {structure.weakest ? (
        <p className="mb-0">
          <i className="bi bi-lightbulb me-1" aria-hidden="true" />
          <strong>
            {t('report.structure.weakest', {
              part: t(`report.star.parts.${structure.weakest}`),
            })}
          </strong>{' '}
          {t(`report.structure.tips.${structure.weakest}`)}
        </p>
      ) : (
        <p className="mb-0">{t('report.structure.allComplete')}</p>
      )}
    </section>
  );
}

function PointList({ items, icon }: { items: readonly string[]; icon: string }) {
  return (
    <ul className="list-unstyled mb-0">
      {items.map((item, index) => (
        <li key={index} className="d-flex gap-2 mb-1">
          <i className={`bi ${icon} mt-1`} aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function QuestionCard({ item }: { item: QuestionFeedback }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  const style = VERDICT_STYLE[item.verdict];
  const verdict = t(`report.questions.verdict.${item.verdict}`);
  return (
    <li className="p-3 p-md-4 border cb-border rounded-3 bg-white">
      <article aria-labelledby={`${id}-q`}>
        <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-2">
          <p className="small cb-text-secondary mb-0">
            {t('report.questions.question', { n: item.seq })} ·{' '}
            {t(`analysis.roundTypes.${item.roundType}`)}
            {item.spoken && (
              <>
                {' · '}
                <i className="bi bi-mic me-1" aria-hidden="true" />
                {t('report.questions.spoken')}
              </>
            )}
          </p>
          <span className={`badge ${style.badge}`}>
            <i className={`bi ${style.icon} me-1`} aria-hidden="true" />
            <span className="visually-hidden">
              {t('report.questions.verdictLabel', { verdict })}
            </span>
            <span aria-hidden="true">{verdict}</span>
          </span>
        </div>
        <h3 id={`${id}-q`} className="h6" style={{ whiteSpace: 'pre-wrap' }}>
          {item.question}
        </h3>

        {item.answer === null ? (
          <p className="small cb-text-secondary">{t('report.questions.answerHidden')}</p>
        ) : (
          <div className="mb-3">
            <button
              type="button"
              className="btn btn-link btn-sm p-0 text-decoration-none"
              aria-expanded={open}
              aria-controls={`${id}-answer`}
              onClick={() => setOpen((v) => !v)}
            >
              <i
                className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'} me-1`}
                aria-hidden="true"
              />
              {open ? t('report.questions.hideAnswer') : t('report.questions.showAnswer')}
            </button>
            <p
              id={`${id}-answer`}
              hidden={!open}
              className="mt-2 mb-0 ps-3 border-start border-2 cb-border"
              style={{ whiteSpace: 'pre-wrap' }}
            >
              {item.answer}
            </p>
          </div>
        )}

        {item.fallback && (
          <p className="small alert alert-light border cb-border py-2">
            <i className="bi bi-info-circle me-1" aria-hidden="true" />
            {t('report.questions.fallback')}
          </p>
        )}

        {item.star && (
          <div className="mb-3">
            <StarBar star={item.star} estimated={item.star.source === 'HEURISTIC'} />
          </div>
        )}

        <div className="row g-3">
          <div className="col-md-6">
            <h4 className="h6">{t('report.questions.worked')}</h4>
            {item.whatWorked.length ? (
              <PointList items={item.whatWorked} icon="bi-hand-thumbs-up text-success" />
            ) : (
              <p className="small cb-text-secondary mb-0">{t('report.questions.nothingWorked')}</p>
            )}
          </div>
          <div className="col-md-6">
            <h4 className="h6">
              {item.fallback
                ? t('report.questions.missingFallback')
                : t('report.questions.missing')}
            </h4>
            {item.missing.length ? (
              <PointList items={item.missing} icon="bi-signpost-split text-warning" />
            ) : (
              <p className="small cb-text-secondary mb-0">{t('report.questions.nothingMissing')}</p>
            )}
          </div>
        </div>

        <div className="mt-3 p-3 rounded-3 cb-surface-muted">
          <h4 className="h6 mb-1">
            <i className="bi bi-stars me-1" aria-hidden="true" />
            {t('report.questions.improved')}
          </h4>
          <p className="small cb-text-secondary mb-2">{t('report.questions.improvedNote')}</p>
          {item.improvedAnswer ? (
            <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>
              {item.improvedAnswer}
            </p>
          ) : (
            <p className="small mb-0">{t('report.questions.noImproved')}</p>
          )}
        </div>
      </article>
    </li>
  );
}

/** Per-question coaching: verdict, the answer (collapsed), what worked, what was missing, an example. */
export function QuestionFeedbackList({ questions }: { questions: readonly QuestionFeedback[] }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="questions-title">
      <h2 id="questions-title" className="h5">
        {t('report.questions.title')}
      </h2>
      <p className="cb-text-secondary">{t('report.questions.intro')}</p>
      {questions.length === 0 ? (
        <p className="mb-0">{t('report.questions.empty')}</p>
      ) : (
        <ol className="list-unstyled d-flex flex-column gap-3 mb-0">
          {questions.map((q) => (
            <QuestionCard key={q.questionId} item={q} />
          ))}
        </ol>
      )}
    </section>
  );
}
