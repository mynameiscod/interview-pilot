import {
  CODING_LANGUAGE_LABELS,
  CODING_LIMITS,
  type CodingLanguage,
  type CodingSubmission,
} from '@cbi/shared-types';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { inputErrorMessage } from '../interviews/messages';
import { CodeEditor } from './CodeEditor';
import { ProblemPanel, RunResultView } from './CodingParts';
import { submissionMessage } from './coding-format';
import { useCodingWorkspace, type SaveStatus } from './useCodingWorkspace';

const MOBILE_QUERY = '(max-width: 767.98px)';

function subscribeMobile(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener?.('change', onChange);
  return () => list.removeEventListener?.('change', onChange);
}
const isMobile = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;

const SAVE_ICON: Record<SaveStatus, string> = {
  saved: 'bi-cloud-check',
  dirty: 'bi-pencil',
  saving: 'bi-arrow-repeat',
  retrying: 'bi-cloud-slash',
  tooLong: 'bi-exclamation-triangle',
  closed: 'bi-lock',
};

function SaveIndicator({ status }: { status: SaveStatus }) {
  const { t } = useTranslation();
  const warn = status === 'retrying' || status === 'tooLong';
  return (
    <span
      role="status"
      className={`small d-inline-flex align-items-center gap-1 ${warn ? 'text-danger' : 'cb-text-secondary'}`}
    >
      <i className={`bi ${SAVE_ICON[status]}`} aria-hidden="true" />
      {t(`coding.save.${status}`, { max: CODING_LIMITS.maxCodeBytes / 1024 })}
    </span>
  );
}

/** An in-page confirmation that takes focus when it opens. */
function Confirm({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="p-3 border border-primary rounded-3 bg-white"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <h3 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="h6">
        {title}
      </h3>
      <p id={`${id}-body`} className="small mb-2">
        {body}
      </p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * The coding workspace for a coding question: the problem on the left, the
 * editor with Run / Submit and the results on the right (stacked on small
 * screens). Submitting answers the question; the interview then moves on.
 */
export function CodingWorkspace({
  sessionId,
  questionId,
  onSubmitted,
  onPaste,
}: {
  sessionId: string;
  questionId: string;
  onSubmitted?: (submission: CodingSubmission) => void;
  /** A paste into the editor, by length only. */
  onPaste?: (length: number) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ws = useCodingWorkspace(sessionId, questionId, onSubmitted);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [pendingLanguage, setPendingLanguage] = useState<CodingLanguage | null>(null);
  const mobile = useSyncExternalStore(subscribeMobile, isMobile, () => false);
  const [mobileDismissed, setMobileDismissed] = useState(false);

  if (ws.query.isPending) {
    return (
      <p className="d-flex align-items-center gap-2 cb-text-secondary" role="status">
        <span className="spinner-border spinner-border-sm" aria-hidden="true" />
        {t('coding.loading')}
      </p>
    );
  }
  const problem = ws.problemData;
  if (ws.query.isError || !problem || !ws.language) {
    return (
      <div className="alert alert-warning" role="alert">
        <p className="fw-semibold mb-1">{t('coding.loadError')}</p>
        <p className="small mb-2">{inputErrorMessage(t, ws.query.error)}</p>
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={() => void ws.query.refetch()}
        >
          {t('coding.retry')}
        </button>
      </div>
    );
  }

  const submitted = ws.submission !== null;
  const locked = submitted || ws.busy === 'submit';
  const canAct = !ws.busy && !submitted && !ws.tooLong;
  const languageLabel = CODING_LANGUAGE_LABELS[ws.language];

  const openSubmit = () => {
    if (canAct) setConfirmSubmit(true);
  };
  const run = () => void ws.run();

  function chooseLanguage(next: CodingLanguage) {
    if (next === ws.language) return;
    if (ws.edited) setPendingLanguage(next);
    else ws.setLanguage(next);
  }

  /** Shortcuts anywhere in the workspace (the editor handles its own and stops them). */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.shiftKey) openSubmit();
    else run();
  }

  const announce = ws.submission
    ? submissionMessage(t, ws.submission)
    : ws.busy === 'run'
      ? t('coding.running')
      : ws.lastRun
        ? t('coding.results.runSummary', { passed: ws.lastRun.passed, total: ws.lastRun.total })
        : '';

  return (
    <div className="row g-4" onKeyDown={onKeyDown}>
      {mobile && !mobileDismissed && (
        <div className="col-12">
          <div className="alert alert-info d-flex align-items-start gap-2 mb-0" role="note">
            <i className="bi bi-laptop" aria-hidden="true" />
            <span className="flex-grow-1 small">{t('coding.mobile.body')}</span>
            <button
              type="button"
              className="btn-close"
              aria-label={t('coding.mobile.dismiss')}
              onClick={() => setMobileDismissed(true)}
            />
          </div>
        </div>
      )}
      <div className="col-lg-5">
        <ProblemPanel problem={problem} headingId={`${id}-problem`} />
      </div>
      <div className="col-lg-7 d-flex flex-column gap-3">
        {ws.judgeDown && !submitted && (
          <div className="alert alert-warning d-flex align-items-start gap-2 mb-0" role="alert">
            <i className="bi bi-exclamation-circle" aria-hidden="true" />
            <span className="flex-grow-1 small">{t('coding.judgeDown')}</span>
            <button
              type="button"
              className="btn-close"
              aria-label={t('room.dismiss')}
              onClick={ws.dismissJudgeDown}
            />
          </div>
        )}
        {ws.problem && (
          <div className="alert alert-warning d-flex align-items-start gap-2 mb-0" role="alert">
            <span className="flex-grow-1 small">{t(`coding.problems.${ws.problem}`)}</span>
            <button
              type="button"
              className="btn-close"
              aria-label={t('room.dismiss')}
              onClick={ws.dismissProblem}
            />
          </div>
        )}
        <section
          className="border cb-border rounded-3 bg-white overflow-hidden"
          aria-label={t('coding.editor.region')}
        >
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 p-2 border-bottom cb-border">
            <div className="d-flex align-items-center gap-2">
              <label htmlFor={`${id}-language`} className="small fw-semibold mb-0">
                {t('coding.language')}
              </label>
              <select
                id={`${id}-language`}
                className="form-select form-select-sm w-auto"
                value={ws.language}
                disabled={locked || pendingLanguage !== null}
                onChange={(e) => chooseLanguage(e.target.value as CodingLanguage)}
              >
                {problem.languages.map((lang) => (
                  <option key={lang} value={lang}>
                    {CODING_LANGUAGE_LABELS[lang]}
                  </option>
                ))}
              </select>
            </div>
            <SaveIndicator status={submitted ? 'closed' : ws.status} />
          </div>
          {pendingLanguage && (
            <div className="p-2 border-bottom cb-border">
              <Confirm
                title={t('coding.switchLanguage.title', {
                  language: CODING_LANGUAGE_LABELS[pendingLanguage],
                })}
                body={t('coding.switchLanguage.body', {
                  language: CODING_LANGUAGE_LABELS[pendingLanguage],
                })}
                confirmLabel={t('coding.switchLanguage.confirm')}
                cancelLabel={t('coding.switchLanguage.cancel')}
                onConfirm={() => {
                  ws.setLanguage(pendingLanguage);
                  setPendingLanguage(null);
                }}
                onCancel={() => setPendingLanguage(null)}
              />
            </div>
          )}
          <CodeEditor
            id={`${id}-editor`}
            value={ws.code}
            language={ws.language}
            onChange={ws.setCode}
            onBlur={() => void ws.saveNow()}
            readOnly={locked}
            ariaLabel={t('coding.editor.label', { language: languageLabel })}
            describedBy={`${id}-shortcuts`}
            onRun={run}
            onSubmit={openSubmit}
            onPaste={onPaste}
          />
          <div className="d-flex flex-wrap align-items-center gap-2 p-2 border-top cb-border">
            <button
              type="button"
              className="btn btn-outline-primary btn-sm"
              disabled={!canAct}
              onClick={run}
            >
              {ws.busy === 'run' ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                  {t('coding.running')}
                </>
              ) : (
                <>
                  <i className="bi bi-play-fill me-1" aria-hidden="true" />
                  {t('coding.run')}
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canAct || confirmSubmit}
              onClick={openSubmit}
            >
              {ws.busy === 'submit' ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                  {t('coding.submitting')}
                </>
              ) : (
                <>
                  <i className="bi bi-send me-1" aria-hidden="true" />
                  {t('coding.submit')}
                </>
              )}
            </button>
            <span id={`${id}-shortcuts`} className="small cb-text-secondary ms-sm-auto">
              {t('coding.editor.shortcuts')}
            </span>
          </div>
          {ws.tooLong && (
            <p className="small text-danger px-2 mb-2" role="alert">
              {t('coding.tooLong', { max: CODING_LIMITS.maxCodeBytes / 1024 })}
            </p>
          )}
        </section>

        {confirmSubmit && !submitted && (
          <Confirm
            title={t('coding.submitConfirm.title')}
            body={t('coding.submitConfirm.body')}
            confirmLabel={t('coding.submitConfirm.confirm')}
            cancelLabel={t('coding.submitConfirm.cancel')}
            busy={ws.busy !== null}
            onConfirm={() => {
              setConfirmSubmit(false);
              void ws.submit();
            }}
            onCancel={() => setConfirmSubmit(false)}
          />
        )}

        <section
          className="p-3 border cb-border rounded-3 bg-white"
          aria-labelledby={`${id}-results`}
        >
          <h3 id={`${id}-results`} className="h6">
            {t('coding.results.title')}
          </h3>
          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            {announce}
          </p>
          {ws.submission ? (
            <div>
              <p className="fw-semibold mb-1">
                <i className="bi bi-check2-circle me-1" aria-hidden="true" />
                {submissionMessage(t, ws.submission)}
              </p>
              <p className="small cb-text-secondary">{t('coding.submitted.next')}</p>
              {ws.submission.result && <RunResultView result={ws.submission.result} />}
            </div>
          ) : ws.lastRun ? (
            <div>
              <p className="small fw-semibold mb-1">
                {t('coding.results.runSummary', {
                  passed: ws.lastRun.passed,
                  total: ws.lastRun.total,
                })}
              </p>
              <RunResultView result={ws.lastRun} />
            </div>
          ) : (
            <p className="small cb-text-secondary mb-0">{t('coding.results.empty')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
