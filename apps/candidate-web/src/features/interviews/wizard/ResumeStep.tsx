import type { ResumeSummary } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExtractionStatus } from '../components/ExtractionStatus';
import { FileDrop } from '../components/FileDrop';
import {
  isExtractionDone,
  queryKeys,
  useInterviewsApi,
  useResumes,
  useResumeStatus,
} from '../interviews-api';
import { formatDate, inputErrorMessage } from '../messages';
import { StepActions } from './StepActions';
import type { StepProps } from './wizard-state';

function statusText(resume: ResumeSummary) {
  switch (resume.extraction.status) {
    case 'READY':
      return 'ready';
    case 'FAILED':
      return 'failed';
    default:
      return 'reading';
  }
}

export function ResumeStep({ state, update, onBack, onNext }: StepProps) {
  const { t, i18n } = useTranslation();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const resumes = useResumes();
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const list = resumes.data ?? [];
  const selected = list.find((r) => r.id === state.resumeId) ?? null;
  const status = useResumeStatus(selected?.id ?? null, selected?.extraction);
  const extraction = status.data ?? selected?.extraction;

  // Once parsing finishes, refresh the list so every row shows the final status.
  const done = isExtractionDone(status.data);
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: queryKeys.resumes, exact: true });
  }, [done, queryClient]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const resume = await api.uploadResume(file);
      const known = list.some((r) => r.id === resume.id);
      queryClient.setQueryData<ResumeSummary[]>(queryKeys.resumes, (old = []) => [
        resume,
        ...old.filter((r) => r.id !== resume.id),
      ]);
      update({ resumeId: resume.id });
      setNotice(known ? t('wizard.resume.duplicate') : t('wizard.resume.uploaded'));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setUploading(false);
    }
  }

  async function remove(resumeId: string) {
    setError(null);
    setNotice(null);
    try {
      await api.deleteResume(resumeId);
      queryClient.setQueryData<ResumeSummary[]>(queryKeys.resumes, (old = []) =>
        old.filter((r) => r.id !== resumeId),
      );
      if (state.resumeId === resumeId) update({ resumeId: null });
      setNotice(t('wizard.resume.deleted'));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setConfirmDelete(null);
    }
  }

  const next = () => {
    if (!selected) {
      setError(t('wizard.resume.chooseOrSkip'));
      return;
    }
    if (extraction?.status === 'FAILED') {
      setError(t('wizard.resume.failedChooseAnother'));
      return;
    }
    onNext();
  };

  return (
    <>
      <p className="cb-text-secondary">{t('wizard.resume.intro')}</p>

      {(notice || error) && (
        <div
          className={`alert ${error ? 'alert-danger' : 'alert-success'} py-2`}
          role={error ? 'alert' : 'status'}
        >
          {error ?? notice}
        </div>
      )}

      {resumes.isPending && <p className="small cb-text-secondary">{t('common.loading')}</p>}
      {resumes.isError && (
        <div className="alert alert-warning py-2" role="alert">
          {t('wizard.resume.listError')}
        </div>
      )}

      {list.length > 0 && (
        <fieldset className="mb-4">
          <legend className="h6">{t('wizard.resume.existing')}</legend>
          <ul className="list-group">
            {list.map((resume) => {
              const failed = resume.extraction.status === 'FAILED';
              const inputId = `${id}-r-${resume.id}`;
              return (
                <li key={resume.id} className="list-group-item">
                  <div className="d-flex flex-wrap align-items-center gap-2">
                    <div className="form-check flex-grow-1 mb-0">
                      <input
                        id={inputId}
                        type="radio"
                        name={`${id}-resume`}
                        className="form-check-input"
                        checked={state.resumeId === resume.id}
                        disabled={failed}
                        aria-describedby={`${inputId}-meta`}
                        onChange={() => {
                          setError(null);
                          update({ resumeId: resume.id });
                        }}
                      />
                      <label htmlFor={inputId} className="form-check-label text-break">
                        {resume.originalName}
                      </label>
                      <div id={`${inputId}-meta`} className="small cb-text-secondary">
                        {t('wizard.resume.uploadedOn', {
                          date: formatDate(i18n.resolvedLanguage, resume.createdAt),
                        })}
                        {' · '}
                        {t(`wizard.resume.rowStatus.${statusText(resume)}`)}
                      </div>
                    </div>
                    {confirmDelete === resume.id ? (
                      <div className="d-flex gap-2" role="group" aria-label={resume.originalName}>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => void remove(resume.id)}
                        >
                          {t('wizard.resume.confirmDelete')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() => setConfirmDelete(null)}
                        >
                          {t('wizard.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        aria-label={t('wizard.resume.deleteNamed', { name: resume.originalName })}
                        onClick={() => setConfirmDelete(resume.id)}
                      >
                        <i className="bi bi-trash me-1" aria-hidden="true" />
                        {t('wizard.resume.delete')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <h3 className="h6">{t('wizard.resume.uploadTitle')}</h3>
      <FileDrop
        label={t('wizard.resume.fileLabel')}
        busy={uploading}
        busyLabel={t('inputs.uploading')}
        onFile={(file) => void upload(file)}
      />

      {selected && (
        <section className="mt-3" aria-label={t('wizard.resume.statusLabel')}>
          <p className="small mb-1">
            {t('wizard.resume.selected', { name: selected.originalName })}
          </p>
          <ExtractionStatus kind="resume" extraction={extraction}>
            <p className="mb-0 mt-2 small">{t('wizard.resume.failedNext')}</p>
          </ExtractionStatus>
        </section>
      )}

      <StepActions
        onBack={onBack}
        onNext={next}
        skipLabel={t('wizard.resume.skip')}
        onSkip={() => {
          update({ resumeId: null });
          onNext();
        }}
      />
    </>
  );
}
