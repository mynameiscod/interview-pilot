import { CODING_LIMITS, type CustomRunResult } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OutputBlock, Verdict } from './CodingParts';
import { codeBytes } from './useCodingWorkspace';

/**
 * "Run with my input": the candidate types their own stdin (for SQL
 * problems, statements that run after the schema) and runs the code once.
 * The output is shown as is; nothing is compared and it is not a test.
 */
export function CustomInputPanel({
  sql,
  disabled,
  busy,
  result,
  onRun,
}: {
  sql: boolean;
  /** Another action is running, the code is too long, or the solution was submitted. */
  disabled: boolean;
  busy: boolean;
  result: CustomRunResult | null;
  onRun: (stdin: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [stdin, setStdin] = useState('');
  const tooLong = codeBytes(stdin) > CODING_LIMITS.maxCustomInputBytes;

  return (
    <section className="border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="h6 mb-0">
        <button
          type="button"
          className="btn btn-link text-decoration-none w-100 text-start p-3 d-flex align-items-center gap-2"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((v) => !v)}
        >
          <i className={`bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'}`} aria-hidden="true" />
          {t('coding.custom.title')}
        </button>
      </h3>
      {open && (
        <div id={`${id}-body`} className="px-3 pb-3">
          <label htmlFor={`${id}-stdin`} className="form-label small fw-semibold mb-1">
            {sql ? t('coding.custom.sqlLabel') : t('coding.custom.label')}
          </label>
          <textarea
            id={`${id}-stdin`}
            className={`form-control form-control-sm font-monospace ${tooLong ? 'is-invalid' : ''}`}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            value={stdin}
            aria-describedby={`${id}-hint`}
            aria-invalid={tooLong ? true : undefined}
            onChange={(e) => setStdin(e.target.value)}
          />
          <p
            id={`${id}-hint`}
            className={`small mt-1 mb-2 ${tooLong ? 'text-danger' : 'cb-text-secondary'}`}
          >
            {tooLong
              ? t('coding.custom.tooLong', { max: CODING_LIMITS.maxCustomInputBytes / 1024 })
              : sql
                ? t('coding.custom.sqlHint')
                : t('coding.custom.hint')}
          </p>
          <button
            type="button"
            className="btn btn-outline-primary btn-sm"
            disabled={disabled || tooLong}
            onClick={() => onRun(stdin)}
          >
            {busy ? (
              <>
                <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" />
                {t('coding.running')}
              </>
            ) : (
              <>
                <i className="bi bi-terminal me-1" aria-hidden="true" />
                {t('coding.custom.run')}
              </>
            )}
          </button>
          <div aria-live="polite">
            {result && !busy && (
              <div className="mt-3">
                <p className="small mb-2 d-flex flex-wrap gap-2 align-items-center">
                  {result.verdict === 'ACCEPTED' ? (
                    <span className="d-inline-flex align-items-center gap-1">
                      <i className="bi bi-check-circle-fill text-success" aria-hidden="true" />
                      {t('coding.custom.finished')}
                    </span>
                  ) : (
                    <Verdict verdict={result.verdict} />
                  )}
                  {result.timeMs !== null && (
                    <span className="cb-text-secondary">
                      {t('coding.results.time', { ms: result.timeMs })}
                    </span>
                  )}
                </p>
                {result.compileOutput && (
                  <OutputBlock
                    label={t('coding.results.compileOutput')}
                    value={result.compileOutput}
                  />
                )}
                <OutputBlock label={t('coding.custom.output')} value={result.stdout} />
                {result.stderr && (
                  <OutputBlock label={t('coding.custom.errors')} value={result.stderr} />
                )}
                <p className="small cb-text-secondary mb-0">{t('coding.custom.notATest')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
