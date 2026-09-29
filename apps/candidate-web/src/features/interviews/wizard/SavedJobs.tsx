import type { JobTargetSummary } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { queryKeys, useInterviewsApi, useJobTargets } from '../interviews-api';
import { formatDate, inputErrorMessage } from '../messages';
import type { StepProps } from './wizard-state';

/** What the candidate will recognise a saved job description by. */
function jobLabel(job: JobTargetSummary, fallback: string) {
  return (
    job.originalName ??
    job.url ??
    job.role?.title ??
    job.roleTitle ??
    job.structured?.title ??
    job.companyName ??
    fallback
  );
}

/**
 * The candidate's saved job descriptions with a delete button each (the
 * stored file and text are removed; past interviews keep only the title).
 */
export function SavedJobs({ update }: Pick<StepProps, 'update'>) {
  const { t, i18n } = useTranslation();
  const api = useInterviewsApi();
  const queryClient = useQueryClient();
  const jobs = useJobTargets();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = jobs.data ?? [];
  // Stays visible after the last one is deleted, to confirm the deletion.
  if (list.length === 0 && !notice) return null;

  async function remove(id: string) {
    setNotice(null);
    setError(null);
    try {
      await api.deleteJobTarget(id);
      queryClient.setQueryData<JobTargetSummary[]>(queryKeys.jobTargets, (old = []) =>
        old.filter((j) => j.id !== id),
      );
      // Forget any wizard reference to it so the next step creates a fresh one.
      update((s) => ({
        ...(s.jdTarget?.id === id ? { jdTarget: null } : {}),
        ...(s.finalTarget?.id === id ? { finalTarget: null } : {}),
        ...(s.targetFields?.id === id ? { targetFields: null } : {}),
        ...(s.prefilledTargetId === id ? { prefilledTargetId: null } : {}),
      }));
      setNotice(t('wizard.jd.deleted'));
    } catch (err) {
      setError(inputErrorMessage(t, err));
    } finally {
      setConfirmDelete(null);
    }
  }

  return (
    <details className="mt-4">
      <summary className="fw-semibold">{t('wizard.jd.savedTitle', { count: list.length })}</summary>
      <p className="small cb-text-secondary mt-2">{t('wizard.jd.savedHint')}</p>
      {(notice || error) && (
        <div
          className={`alert ${error ? 'alert-danger' : 'alert-success'} py-2`}
          role={error ? 'alert' : 'status'}
        >
          {error ?? notice}
        </div>
      )}
      <ul className="list-group" hidden={list.length === 0}>
        {list.map((job) => {
          const name = jobLabel(job, t(`wizard.jd.sources.${job.source}`));
          return (
            <li key={job.id} className="list-group-item d-flex flex-wrap align-items-center gap-2">
              <div className="flex-grow-1">
                <div className="text-break">{name}</div>
                <div className="small cb-text-secondary">
                  {t(`wizard.jd.sources.${job.source}`)}
                  {' · '}
                  {t('wizard.jd.addedOn', {
                    date: formatDate(i18n.resolvedLanguage, job.createdAt),
                  })}
                </div>
              </div>
              {confirmDelete === job.id ? (
                <div className="d-flex gap-2" role="group" aria-label={name}>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void remove(job.id)}
                  >
                    {t('wizard.jd.confirmDelete')}
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
                  aria-label={t('wizard.jd.deleteNamed', { name })}
                  onClick={() => setConfirmDelete(job.id)}
                >
                  <i className="bi bi-trash me-1" aria-hidden="true" />
                  {t('wizard.jd.delete')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
