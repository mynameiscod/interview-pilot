import {
  DESIGN_LIMITS,
  DESIGN_NOTE_SECTIONS,
  type DesignNotes,
  type DesignWorkspace as DesignWorkspaceData,
} from '@cbi/shared-types';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { DifficultyBadge, Statement } from '../coding/CodingParts';
import { useDesignWorkspace, type DesignSaveStatus } from './useDesignWorkspace';
import { Whiteboard } from './Whiteboard';

const SAVE_ICON: Record<DesignSaveStatus, string> = {
  saved: 'bi-cloud-check',
  dirty: 'bi-pencil',
  saving: 'bi-arrow-repeat',
  retrying: 'bi-cloud-slash',
  closed: 'bi-lock',
};

function NotesPanel({
  notes,
  readOnly,
  onChange,
  onBlur,
}: {
  notes: DesignNotes;
  readOnly: boolean;
  onChange: (next: DesignNotes) => void;
  onBlur: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="d-flex flex-column gap-3">
      {DESIGN_NOTE_SECTIONS.map((section) => (
        <div key={section}>
          <label htmlFor={`${id}-${section}`} className="form-label small fw-semibold mb-0">
            {t(`design.notes.${section}.label`)}
          </label>
          <p id={`${id}-${section}-hint`} className="small cb-text-secondary mb-1">
            {t(`design.notes.${section}.hint`)}
          </p>
          <textarea
            id={`${id}-${section}`}
            className="form-control form-control-sm"
            rows={3}
            maxLength={DESIGN_LIMITS.maxNoteChars}
            readOnly={readOnly}
            aria-describedby={`${id}-${section}-hint`}
            value={notes[section]}
            onChange={(e) => onChange({ ...notes, [section]: e.target.value })}
            onBlur={onBlur}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The system design workspace: the prompt, a boxes-and-arrows whiteboard
 * and structured notes, autosaved; submitting answers the design question,
 * after which the interviewer asks about the design.
 */
export function DesignWorkspace({
  sessionId,
  questionId,
  onSubmitted,
}: {
  sessionId: string;
  questionId: string;
  onSubmitted?: (workspace: DesignWorkspaceData) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ws = useDesignWorkspace(sessionId, questionId, onSubmitted);
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);

  if (ws.query.isPending) {
    return (
      <p className="d-flex align-items-center gap-2 cb-text-secondary" role="status">
        <span className="spinner-border spinner-border-sm" aria-hidden="true" />
        {t('design.loading')}
      </p>
    );
  }
  const prompt = ws.prompt;
  const design = ws.design;
  if (ws.query.isError || !prompt || !design) {
    return (
      <div className="alert alert-warning" role="alert">
        <p className="fw-semibold mb-1">{t('design.loadError')}</p>
        <p className="small mb-2">{inputErrorMessage(t, ws.query.error)}</p>
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={() => void ws.query.refetch()}
        >
          {t('design.retry')}
        </button>
      </div>
    );
  }
  const readOnly = ws.submitted;
  const warn = ws.status === 'retrying';

  return (
    <div className="d-flex flex-column gap-3">
      <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-prompt`}>
        <p className="small cb-text-secondary mb-1">{t('design.promptLabel')}</p>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <h2 id={`${id}-prompt`} className="h5 mb-0">
            {prompt.title}
          </h2>
          <DifficultyBadge difficulty={prompt.difficulty} />
        </div>
        <Statement text={prompt.prompt} />
        {prompt.focusAreas.length > 0 && (
          <>
            <h3 className="h6">{t('design.focus')}</h3>
            <ul className="mb-0">
              {prompt.focusAreas.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <p className="small cb-text-secondary mb-0">{t('design.intro')}</p>
        <span
          role="status"
          className={`small d-inline-flex align-items-center gap-1 ${warn ? 'text-danger' : 'cb-text-secondary'}`}
        >
          <i className={`bi ${SAVE_ICON[ws.status]}`} aria-hidden="true" />
          {t(`design.save.${ws.status}`)}
        </span>
      </div>

      <div className="row g-3">
        <section className="col-xl-7" aria-labelledby={`${id}-board`}>
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h3 id={`${id}-board`} className="h6">
              {t('design.board.title')}
            </h3>
            <Whiteboard diagram={design.diagram} readOnly={readOnly} onChange={ws.setDiagram} />
          </div>
        </section>
        <section className="col-xl-5" aria-labelledby={`${id}-notes`}>
          <div className="p-3 border cb-border rounded-3 bg-white h-100">
            <h3 id={`${id}-notes`} className="h6">
              {t('design.notes.title')}
            </h3>
            <NotesPanel
              notes={design.notes}
              readOnly={readOnly}
              onChange={ws.setNotes}
              onBlur={() => void ws.saveNow()}
            />
          </div>
        </section>
      </div>

      {ws.problem && (
        <div className="alert alert-warning d-flex align-items-start gap-2 mb-0" role="alert">
          <span className="flex-grow-1 small">{t(`design.problems.${ws.problem}`)}</span>
          <button
            type="button"
            className="btn-close"
            aria-label={t('room.dismiss')}
            onClick={ws.dismissProblem}
          />
        </div>
      )}

      {readOnly ? (
        <p className="fw-semibold mb-0" role="status">
          <i className="bi bi-check2-circle me-1" aria-hidden="true" />
          {t('design.submitted')}
        </p>
      ) : confirm ? (
        <section
          role="alertdialog"
          aria-labelledby={`${id}-confirm`}
          aria-describedby={`${id}-confirm-body`}
          className="p-3 border border-primary rounded-3 bg-white"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirm(false);
          }}
        >
          <h3 id={`${id}-confirm`} ref={confirmRef} tabIndex={-1} className="h6">
            {t('design.confirm.title')}
          </h3>
          <p id={`${id}-confirm-body`} className="small mb-2">
            {t('design.confirm.body')}
          </p>
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={ws.busy}
              onClick={() => {
                setConfirm(false);
                void ws.submit();
              }}
            >
              {t('design.confirm.yes')}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              onClick={() => setConfirm(false)}
            >
              {t('design.confirm.no')}
            </button>
          </div>
        </section>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={ws.busy}
            onClick={() => setConfirm(true)}
          >
            {ws.busy ? (
              <>
                <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                {t('design.submitting')}
              </>
            ) : (
              <>
                <i className="bi bi-send me-1" aria-hidden="true" />
                {t('design.submit')}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** The submitted design, read-only, beside the interviewer's probes about it. */
export function DesignReference({
  sessionId,
  questionId,
}: {
  sessionId: string;
  questionId: string;
}) {
  const { t } = useTranslation();
  return (
    <details className="p-3 border cb-border rounded-3 bg-white">
      <summary className="fw-semibold">{t('design.reference')}</summary>
      <div className="mt-3">
        <DesignWorkspace sessionId={sessionId} questionId={questionId} />
      </div>
    </details>
  );
}
