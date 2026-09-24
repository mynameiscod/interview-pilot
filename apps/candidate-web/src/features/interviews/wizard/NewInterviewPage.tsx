import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { useInterview, useJobTarget } from '../interviews-api';
import { JobStep } from './JobStep';
import { ResumeStep } from './ResumeStep';
import { StartStep } from './StartStep';
import { TargetStep } from './TargetStep';
import {
  clearWizardState,
  initialWizardState,
  prefillFromTarget,
  saveWizardState,
  startingState,
  WIZARD_STEPS,
  type WizardState,
} from './wizard-state';

function Stepper({ current }: { current: number }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('wizard.progressLabel')} className="mb-4">
      <ol className="list-unstyled d-flex flex-wrap gap-2 gap-md-4 mb-0">
        {WIZARD_STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li
              key={step}
              className="d-flex align-items-center gap-2"
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span
                className={`d-inline-flex align-items-center justify-content-center rounded-circle border fw-semibold ${
                  state === 'todo' ? 'cb-border cb-text-secondary' : 'border-primary'
                } ${state === 'current' ? 'bg-primary text-white' : ''}`}
                style={{ width: '2rem', height: '2rem' }}
                aria-hidden="true"
              >
                {state === 'done' ? <i className="bi bi-check-lg" /> : index + 1}
              </span>
              <span className={state === 'current' ? 'fw-semibold' : 'cb-text-secondary'}>
                <span className="visually-hidden">
                  {t('wizard.stepOf', { step: index + 1, total: WIZARD_STEPS.length })}{' '}
                </span>
                {t(`wizard.steps.${step}`)}
                {state === 'done' && (
                  <span className="visually-hidden"> ({t('wizard.stepDone')})</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * "Edit inputs" for an interview this tab did not create: prefill what the
 * server can tell us (resume, link/file, company, role).
 */
function usePrefillFromInterview(
  editId: string | null,
  enabled: boolean,
  apply: (fn: (s: WizardState) => WizardState) => void,
) {
  const interview = useInterview(editId ?? '', enabled && Boolean(editId));
  const jobTargetId = enabled ? (interview.data?.jobTargetId ?? null) : null;
  const target = useJobTarget(jobTargetId);
  const [done, setDone] = useState(!enabled);
  if (!done && interview.data && target.data) {
    setDone(true);
    const resumeId = interview.data.resumeId;
    const data = target.data;
    apply((s) => prefillFromTarget(s, resumeId, data));
  }
  if (!done && (interview.isError || target.isError)) setDone(true);
}

export function NewInterviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('edit');
  const [initial] = useState(() => startingState(editId));
  const [state, setState] = useState<WizardState>(initial.state);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(state.step);

  usePrefillFromInterview(editId, Boolean(editId) && !initial.restored, setState);

  useEffect(() => {
    saveWizardState(state);
  }, [state]);

  // Move focus to the new step's heading so keyboard and screen-reader users start there.
  useEffect(() => {
    if (shownStep.current === state.step) return;
    shownStep.current = state.step;
    headingRef.current?.focus();
  }, [state.step]);

  const update = (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }));
  const go = (step: number) => update({ step });
  const stepKey = WIZARD_STEPS[state.step] ?? 'start';
  const common = {
    state,
    update,
    onBack: () => go(Math.max(0, state.step - 1)),
    onNext: () => go(Math.min(WIZARD_STEPS.length - 1, state.step + 1)),
  };

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-lg-9 col-xl-8">
          <div className="d-flex flex-wrap align-items-start justify-content-between gap-2">
            <div>
              <h1 className="h3">{t('wizard.title')}</h1>
              <p className="cb-text-secondary">{t('wizard.subtitle')}</p>
            </div>
            {state.step > 0 && (
              <button
                type="button"
                className="btn btn-link btn-sm"
                onClick={() => {
                  clearWizardState();
                  setState(initialWizardState());
                }}
              >
                {t('wizard.startOver')}
              </button>
            )}
          </div>
          <Stepper current={state.step} />
          <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="step-title">
            <h2 id="step-title" ref={headingRef} tabIndex={-1} className="h4 mb-3">
              {t(`wizard.stepTitles.${stepKey}`)}
            </h2>
            {stepKey === 'start' && <StartStep onNext={common.onNext} />}
            {stepKey === 'resume' && <ResumeStep {...common} />}
            {stepKey === 'jd' && <JobStep {...common} />}
            {stepKey === 'target' && (
              <TargetStep
                {...common}
                onSubmitted={(interviewId, patch) => {
                  // Saved right away: the page unmounts before its effects would run again.
                  const next = { ...state, ...patch, submittedInterviewId: interviewId };
                  saveWizardState(next);
                  setState(next);
                  void navigate(`/app/interviews/${interviewId}/analysis`);
                }}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
