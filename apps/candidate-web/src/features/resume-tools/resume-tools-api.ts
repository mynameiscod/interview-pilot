import type {
  CreateResumeTextBody,
  JobTargetSummary,
  ResumeMatchReport,
  ResumeSummary,
  ResumeTailoringSummary,
  ResumeToolsBody,
  UpdateJdStructuredBody,
  UpdateResumeStructuredBody,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { POLL_INTERVAL_MS, queryKeys } from '../interviews/interviews-api';

const enc = encodeURIComponent;

function resumeToolsApi(api: ApiClient) {
  return {
    /** A resume from pasted text (e.g. a LinkedIn profile copied by the candidate). */
    createResumeFromText: (body: CreateResumeTextBody) =>
      api.post<ResumeSummary>('/resumes/text', body),
    saveResumeRevision: (id: string, body: UpdateResumeStructuredBody) =>
      api.put<ResumeSummary>(`/resumes/${enc(id)}/structured`, body),
    revertResumeRevision: (id: string) =>
      api.delete<ResumeSummary>(`/resumes/${enc(id)}/structured`),
    saveJdRevision: (id: string, body: UpdateJdStructuredBody) =>
      api.put<JobTargetSummary>(`/jobs/${enc(id)}/structured`, body),
    revertJdRevision: (id: string) => api.delete<JobTargetSummary>(`/jobs/${enc(id)}/structured`),
    match: (body: ResumeToolsBody) => api.post<ResumeMatchReport>('/resume-tools/match', body),
    requestTailoring: (body: ResumeToolsBody) =>
      api.post<ResumeTailoringSummary>('/resume-tools/tailorings', body),
    getTailoring: (id: string) =>
      api.get<ResumeTailoringSummary>(`/resume-tools/tailorings/${enc(id)}`),
  };
}

export type ResumeToolsApi = ReturnType<typeof resumeToolsApi>;

export function useResumeToolsApi(): ResumeToolsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => resumeToolsApi(manager.api), [manager]);
}

export const resumeToolsKeys = {
  match: (resumeId: string, jobTargetId: string) =>
    ['resume-tools', 'match', resumeId, jobTargetId] as const,
  tailoring: (id: string) => ['resume-tools', 'tailoring', id] as const,
};

/**
 * The match score for a resume and job description. It is recomputed on the
 * server (free) whenever either input changes, so edits show up at once.
 */
export function useResumeMatch(
  resumeId: string | null,
  jobTargetId: string | null,
  stamp: string = '',
) {
  const api = useResumeToolsApi();
  return useQuery({
    queryKey: [...resumeToolsKeys.match(resumeId ?? '', jobTargetId ?? ''), stamp],
    queryFn: () => api.match({ resumeId: resumeId!, jobTargetId: jobTargetId! }),
    enabled: Boolean(resumeId && jobTargetId),
    retry: false,
    staleTime: 60_000,
  });
}

/** Polls tailoring suggestions until the worker has finished them. */
export function useTailoring(id: string | null) {
  const api = useResumeToolsApi();
  return useQuery({
    queryKey: resumeToolsKeys.tailoring(id ?? ''),
    queryFn: () => api.getTailoring(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? POLL_INTERVAL_MS : false),
  });
}

/** Keeps the cached resume/JD lists in step after a revision is saved or reverted. */
export function useRevisionCache() {
  const client = useQueryClient();
  return {
    resume(updated: ResumeSummary) {
      client.setQueryData<ResumeSummary[]>(queryKeys.resumes, (old) =>
        old?.map((r) => (r.id === updated.id ? updated : r)),
      );
      void client.invalidateQueries({ queryKey: ['resume-tools', 'match'] });
    },
    jd(updated: JobTargetSummary) {
      client.setQueryData(queryKeys.jobTarget(updated.id), updated);
      client.setQueryData<JobTargetSummary[]>(queryKeys.jobTargets, (old) =>
        old?.map((j) => (j.id === updated.id ? updated : j)),
      );
      void client.invalidateQueries({ queryKey: ['resume-tools', 'match'] });
    },
  };
}
