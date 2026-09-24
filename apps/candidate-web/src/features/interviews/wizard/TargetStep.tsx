import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typeahead } from '../components/Typeahead';
import { queryKeys, useInterviewsApi, useJobTarget, useResumes } from '../interviews-api';
import { inputErrorMessage } from '../messages';
import { StepActions } from './StepActions';
import {
  fieldsKey,
  finalTargetKey,
  hasJobDescription,
  savedJdTarget,
  targetChoices,
  targetFieldsBody,
  type StepProps,
  type WizardState,
} from './wizard-state';

/** What a submit-time target is made from (pasted text or the role only). */
function finalTargetSource(state: WizardState) {
  return hasJobDescription(state) && state.jdTab === 'PASTE'
    ? ({ source: 'PASTE', text: state.jdText.trim() } as const)
    : ({ source: 'ROLE_ONLY' } as const);
}

interface Props extends StepProps {
  onSubmitted: (interviewId: string, progress: Partial<WizardState>) => void;
}

export function TargetStep({ state, update, onBack, onSubmitted }: Props) {
  const { t } = useTranslation();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const resumes = useResumes();
  const saved = savedJdTarget(state);
  const savedTarget = useJobTarget(saved?.id ?? null, { untilRead: true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  const jdProvided = hasJobDescription(state);

  // Prefill company and role once from an uploaded or linked JD: what is saved
  // on the target, else what was read from the JD. Fields already filled stay.
  const loaded = savedTarget.data;
  useEffect(() => {
    if (!loaded || state.prefilledTargetId === loaded.id) return;
    const chosen = Boolean(loaded.company || loaded.companyName || loaded.role || loaded.roleTitle);
    if (!chosen && loaded.extraction.status !== 'READY' && loaded.extraction.status !== 'FAILED')
      return;
    const found = targetChoices(loaded);
    update({
      prefilledTargetId: loaded.id,
      company: state.company ?? found.company,
      role: state.role ?? found.role,
    });
  }, [loaded, state.prefilledTargetId, state.company, state.role, update]);
  const resumeName = resumes.data?.find((r) => r.id === state.resumeId)?.originalName;

  async function submit() {
    setError(null);
    setRoleError(null);
    if (!jdProvided && !state.role?.name.trim()) {
      setRoleError(t('wizard.target.roleRequired'));
      return;
    }
    setPending(true);
    // Each stage records what it created, so a retry after a failure (or after
    // going back without changing anything) reuses it instead of duplicating it.
    let progress: Partial<WizardState> = {};
    try {
      const fields = targetFieldsBody(state.company, state.role);
      const key = fieldsKey(fields);
      let jobTargetId: string;
      let fieldsSaved = false;
      if (saved) {
        jobTargetId = saved.id;
      } else {
        const source = finalTargetSource(state);
        const sourceKey = finalTargetKey(source);
        if (state.finalTarget?.key === sourceKey) {
          jobTargetId = state.finalTarget.id;
        } else {
          jobTargetId = (await api.createJobTarget({ ...source, ...fields })).id;
          fieldsSaved = true;
          progress = { ...progress, finalTarget: { id: jobTargetId, key: sourceKey } };
        }
      }
      // Existing targets (uploads, links, or one reused after going back) get
      // the chosen company and role before the interview is created.
      const known = state.targetFields;
      if (!fieldsSaved && !(known?.id === jobTargetId && known.key === key)) {
        await api.updateJobTarget(jobTargetId, fields);
        void queryClient.invalidateQueries({ queryKey: queryKeys.jobTarget(jobTargetId) });
      }
      progress = { ...progress, targetFields: { id: jobTargetId, key } };

      const interviewKey = `${jobTargetId}|${state.resumeId ?? ''}`;
      let interviewId: string;
      if (state.interview?.key === interviewKey) {
        interviewId = state.interview.id;
      } else {
        interviewId = (await api.createInterview(jobTargetId, state.resumeId)).id;
        progress = { ...progress, interview: { id: interviewId, key: interviewKey } };
      }

      const analysing = await api.analyze(interviewId);
      queryClient.setQueryData(queryKeys.interview(interviewId), analysing);

      if (state.replacesInterviewId && state.replacesInterviewId !== interviewId) {
        // The earlier plan is replaced by this one; failing to cancel it is harmless.
        await api.cancel(state.replacesInterviewId).catch(() => undefined);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.interviews, exact: true });
      onSubmitted(interviewId, progress);
    } catch (err) {
      update(progress);
      setError(inputErrorMessage(t, err));
      setPending(false);
    }
  }

  const jdSummary = state.jdSkipped
    ? t('wizard.target.summary.jdNone')
    : state.jdTab === 'PASTE'
      ? jdProvided
        ? t('wizard.target.summary.jdPasted', { count: state.jdText.trim().length })
        : t('wizard.target.summary.jdNone')
      : saved
        ? saved.label
        : t('wizard.target.summary.jdNone');

  return (
    <>
      <p className="cb-text-secondary">
        {jdProvided ? t('wizard.target.introWithJd') : t('wizard.target.introNoJd')}
      </p>

      <Typeahead
        kind="companies"
        label={t('wizard.target.companyLabel')}
        hint={t('wizard.target.companyHint')}
        value={state.company}
        onChange={(company) => update({ company })}
      />
      <Typeahead
        kind="roles"
        label={t('wizard.target.roleLabel')}
        hint={jdProvided ? t('wizard.target.roleHintJd') : t('wizard.target.roleHintNoJd')}
        required={!jdProvided}
        error={roleError}
        value={state.role}
        onChange={(role) => {
          setRoleError(null);
          update({ role });
        }}
      />

      <section className="border cb-border rounded-3 p-3" aria-labelledby="wizard-summary">
        <h3 id="wizard-summary" className="h6">
          {t('wizard.target.summary.title')}
        </h3>
        <dl className="row small mb-0">
          <dt className="col-sm-4">{t('wizard.target.summary.resume')}</dt>
          <dd className="col-sm-8 text-break">
            {state.resumeId
              ? (resumeName ?? t('wizard.target.summary.resumeSelected'))
              : t('wizard.target.summary.resumeNone')}
          </dd>
          <dt className="col-sm-4">{t('wizard.target.summary.jd')}</dt>
          <dd className="col-sm-8 text-break">{jdSummary}</dd>
        </dl>
      </section>

      {state.replacesInterviewId && (
        <p className="small cb-text-secondary mt-3 mb-0">{t('wizard.target.replaces')}</p>
      )}

      {error && (
        <div className="alert alert-danger mt-3 mb-0" role="alert">
          {error}
        </div>
      )}

      <StepActions
        onBack={onBack}
        onNext={() => void submit()}
        nextLabel={t('wizard.target.submit')}
        nextPending={pending}
        pendingLabel={t('wizard.target.submitting')}
      />
    </>
  );
}
