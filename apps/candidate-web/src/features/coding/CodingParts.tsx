import type { CodeRunResult, JudgeVerdict, PublicProblem, TestOutcome } from '@cbi/shared-types';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** `inline code` in backticks becomes <code>; everything else stays text. */
function withInlineCode(text: string): ReactNode[] {
  return text
    .split('`')
    .map((part, i) =>
      i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
    );
}

/** Blank-line paragraphs; single line breaks are kept. */
export function Statement({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((paragraph, i) => (
          <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {withInlineCode(paragraph)}
          </p>
        ))}
    </>
  );
}

const DIFFICULTY_STYLE = {
  EASY: 'text-bg-light border-success',
  MEDIUM: 'text-bg-light border-warning',
  HARD: 'text-bg-light border-danger',
} as const;

export function DifficultyBadge({ difficulty }: { difficulty: keyof typeof DIFFICULTY_STYLE }) {
  const { t } = useTranslation();
  return (
    <span className={`badge rounded-pill border fw-normal ${DIFFICULTY_STYLE[difficulty]}`}>
      <span className="visually-hidden">{t('coding.difficultyLabel')}: </span>
      {t(`coding.difficulty.${difficulty}`)}
    </span>
  );
}

function Block({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2">
      <p className="small fw-semibold mb-1">{label}</p>
      <pre className="bg-light border cb-border rounded-2 p-2 mb-0 small" tabIndex={0}>
        {value === null || value === '' ? (
          <span className="cb-text-secondary">{t('coding.results.noOutput')}</span>
        ) : (
          value
        )}
      </pre>
    </div>
  );
}

/** The problem: title, difficulty, statement, visible tests and how many are hidden. */
export function ProblemPanel({
  problem,
  headingId,
}: {
  problem: PublicProblem;
  headingId: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="p-4 border cb-border rounded-3 bg-white h-100" aria-labelledby={headingId}>
      <p className="small cb-text-secondary mb-1">{t('coding.problemLabel')}</p>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h2 id={headingId} className="h5 mb-0">
          {problem.title}
        </h2>
        <DifficultyBadge difficulty={problem.difficulty} />
      </div>
      <Statement text={problem.statement} />
      <p className="small cb-text-secondary">
        {t('coding.limits', { cpu: problem.limits.cpuMs, memory: problem.limits.memoryMb })}
      </p>
      <h3 className="h6">{t('coding.examples')}</h3>
      <ol className="list-unstyled mb-0">
        {problem.visibleTests.map((test, i) => (
          <li key={i} className="mb-3">
            <p className="small fw-semibold mb-1">{t('coding.example', { n: i + 1 })}</p>
            <Block label={t('coding.input')} value={test.input} />
            <Block label={t('coding.expectedOutput')} value={test.expectedOutput} />
            {test.explanation && (
              <p className="small mb-0">
                <span className="fw-semibold">{t('coding.explanation')}:</span>{' '}
                {withInlineCode(test.explanation)}
              </p>
            )}
          </li>
        ))}
      </ol>
      {problem.hiddenTestCount > 0 && (
        <p className="small mb-0">
          <i className="bi bi-eye-slash me-1" aria-hidden="true" />
          <span className="fw-semibold">
            {t('coding.hiddenTests', { count: problem.hiddenTestCount })}
          </span>{' '}
          <span className="cb-text-secondary">{t('coding.hiddenNote')}</span>
        </p>
      )}
    </section>
  );
}

const VERDICT_ICON: Record<JudgeVerdict, string> = {
  ACCEPTED: 'bi-check-circle-fill text-success',
  WRONG_ANSWER: 'bi-x-circle-fill text-danger',
  COMPILE_ERROR: 'bi-exclamation-triangle-fill text-danger',
  RUNTIME_ERROR: 'bi-exclamation-triangle-fill text-danger',
  TIME_LIMIT: 'bi-hourglass-bottom text-danger',
  MEMORY_LIMIT: 'bi-memory text-danger',
  JUDGE_ERROR: 'bi-question-circle-fill cb-text-secondary',
};

/** A verdict in words and an icon (never colour alone). */
export function Verdict({ verdict }: { verdict: JudgeVerdict }) {
  const { t } = useTranslation();
  return (
    <span className="d-inline-flex align-items-center gap-1">
      <i className={`bi ${VERDICT_ICON[verdict]}`} aria-hidden="true" />
      {t(`coding.verdicts.${verdict}`)}
    </span>
  );
}

function TestRow({ test, n, hiddenN }: { test: TestOutcome; n: number; hiddenN: number }) {
  const { t } = useTranslation();
  const label = test.hidden
    ? t('coding.results.hiddenTest', { n: hiddenN })
    : t('coding.results.test', { n });
  return (
    <li className="py-2 border-bottom cb-border">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <span className="fw-semibold small">{label}</span>
        <span className="small d-inline-flex gap-2">
          <Verdict verdict={test.verdict} />
          {test.timeMs !== null && (
            <span className="cb-text-secondary">
              {t('coding.results.time', { ms: test.timeMs })}
            </span>
          )}
        </span>
      </div>
      {!test.hidden && test.verdict !== 'ACCEPTED' && test.verdict !== 'COMPILE_ERROR' && (
        <div className="row g-2 mt-1">
          <div className="col-sm-6">
            <Block label={t('coding.yourOutput')} value={test.stdout} />
          </div>
          <div className="col-sm-6">
            <Block label={t('coding.expectedOutput')} value={test.expectedOutput} />
          </div>
        </div>
      )}
    </li>
  );
}

/** Per-test verdicts; hidden tests show only their verdict. */
export function RunResultView({ result }: { result: CodeRunResult }) {
  const { t } = useTranslation();
  const numbered: { test: TestOutcome; n: number; hiddenN: number }[] = [];
  let visible = 0;
  let hidden = 0;
  for (const test of result.tests) {
    if (test.hidden) hidden += 1;
    else visible += 1;
    numbered.push({ test, n: visible, hiddenN: hidden });
  }
  return (
    <div>
      {result.compileOutput && (
        <Block label={t('coding.results.compileOutput')} value={result.compileOutput} />
      )}
      <ol className="list-unstyled mb-0">
        {numbered.map((row, i) => (
          <TestRow key={i} test={row.test} n={row.n} hiddenN={row.hiddenN} />
        ))}
      </ol>
    </div>
  );
}
