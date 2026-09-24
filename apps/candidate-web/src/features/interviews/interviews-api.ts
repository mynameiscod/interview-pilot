import type {
  CreateJobTargetBody,
  Extraction,
  InterviewSummary,
  JobTargetSummary,
  LibrarySearchItem,
  ResumeSummary,
  UpdateInterviewSetupBody,
  UpdateJobTargetBody,
  UploadJobTargetFields,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

/** How often pending inputs and analyses are re-checked. */
export const POLL_INTERVAL_MS = 2_000;

export const isExtractionDone = (e: Pick<Extraction, 'status'> | undefined) =>
  e?.status === 'READY' || e?.status === 'FAILED';

function interviewsApi(api: ApiClient) {
  return {
    listResumes: () => api.get<ResumeSummary[]>('/resumes'),
    uploadResume: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post<ResumeSummary>('/resumes', form);
    },
    resumeStatus: (id: string) => api.get<Extraction>(`/resumes/${encodeURIComponent(id)}/status`),
    deleteResume: (id: string) => api.delete<void>(`/resumes/${encodeURIComponent(id)}`),

    createJobTarget: (body: CreateJobTargetBody) => api.post<JobTargetSummary>('/jobs', body),
    uploadJobTarget: (file: File, fields: UploadJobTargetFields = {}) => {
      const form = new FormData();
      form.append('file', file);
      for (const [key, value] of Object.entries(fields)) {
        if (value) form.append(key, value);
      }
      return api.post<JobTargetSummary>('/jobs/upload', form);
    },
    getJobTarget: (id: string) => api.get<JobTargetSummary>(`/jobs/${encodeURIComponent(id)}`),
    /** Replaces the company and role of an existing job target (omitted fields are cleared). */
    updateJobTarget: (id: string, body: UpdateJobTargetBody) =>
      api.patch<JobTargetSummary>(`/jobs/${encodeURIComponent(id)}`, body),
    jobTargetStatus: (id: string) => api.get<Extraction>(`/jobs/${encodeURIComponent(id)}/status`),

    searchLibrary: (kind: 'companies' | 'roles', q: string) =>
      api.get<LibrarySearchItem[]>(`/${kind}?q=${encodeURIComponent(q)}&limit=8`),

    listInterviews: () => api.get<InterviewSummary[]>('/interviews'),
    getInterview: (id: string) =>
      api.get<InterviewSummary>(`/interviews/${encodeURIComponent(id)}`),
    createInterview: (jobTargetId: string, resumeId: string | null) =>
      api.post<InterviewSummary>('/interviews', { jobTargetId, resumeId }),
    analyze: (id: string) =>
      api.post<InterviewSummary>(`/interviews/${encodeURIComponent(id)}/analyze`),
    updateSetup: (id: string, body: UpdateInterviewSetupBody) =>
      api.patch<InterviewSummary>(`/interviews/${encodeURIComponent(id)}/setup`, body),
    cancel: (id: string) =>
      api.post<InterviewSummary>(`/interviews/${encodeURIComponent(id)}/cancel`),
  };
}

export type InterviewsApi = ReturnType<typeof interviewsApi>;

export function useInterviewsApi(): InterviewsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => interviewsApi(manager.api), [manager]);
}

export const queryKeys = {
  resumes: ['resumes'] as const,
  resumeStatus: (id: string) => ['resumes', id, 'status'] as const,
  jobTarget: (id: string) => ['jobs', id] as const,
  jobStatus: (id: string) => ['jobs', id, 'status'] as const,
  library: (kind: string, q: string) => ['library', kind, q] as const,
  interviews: ['interviews'] as const,
  interview: (id: string) => ['interviews', id] as const,
};

export function useResumes() {
  const api = useInterviewsApi();
  return useQuery({ queryKey: queryKeys.resumes, queryFn: api.listResumes });
}

/** Polls a resume's extraction until it is READY or FAILED. */
export function useResumeStatus(id: string | null, initial?: Extraction) {
  const api = useInterviewsApi();
  return useQuery({
    queryKey: queryKeys.resumeStatus(id ?? ''),
    queryFn: () => api.resumeStatus(id!),
    enabled: Boolean(id) && !isExtractionDone(initial),
    initialData: initial,
    refetchInterval: (q) => (isExtractionDone(q.state.data) ? false : POLL_INTERVAL_MS),
  });
}

/** Polls a job target's extraction until it is READY or FAILED. */
export function useJobStatus(id: string | null, initial?: Extraction) {
  const api = useInterviewsApi();
  return useQuery({
    queryKey: queryKeys.jobStatus(id ?? ''),
    queryFn: () => api.jobTargetStatus(id!),
    enabled: Boolean(id) && !isExtractionDone(initial),
    initialData: initial,
    refetchInterval: (q) => (isExtractionDone(q.state.data) ? false : POLL_INTERVAL_MS),
  });
}

/** Loads a job target; with `untilRead`, keeps polling until its extraction finishes. */
export function useJobTarget(id: string | null, opts: { untilRead?: boolean } = {}) {
  const api = useInterviewsApi();
  return useQuery({
    queryKey: queryKeys.jobTarget(id ?? ''),
    queryFn: () => api.getJobTarget(id!),
    enabled: Boolean(id),
    refetchInterval: (q) =>
      opts.untilRead && q.state.data && !isExtractionDone(q.state.data.extraction)
        ? POLL_INTERVAL_MS
        : false,
  });
}

export function useLibrarySearch(kind: 'companies' | 'roles', q: string, enabled: boolean) {
  const api = useInterviewsApi();
  return useQuery({
    queryKey: queryKeys.library(kind, q),
    queryFn: () => api.searchLibrary(kind, q),
    enabled,
    staleTime: 60_000,
  });
}

export function useInterviews() {
  const api = useInterviewsApi();
  return useQuery({ queryKey: queryKeys.interviews, queryFn: api.listInterviews });
}

/** Loads an interview and keeps polling while the role analysis runs. */
export function useInterview(id: string, enabled = true) {
  const api = useInterviewsApi();
  return useQuery({
    queryKey: queryKeys.interview(id),
    queryFn: () => api.getInterview(id),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.state === 'ROLE_ANALYSIS' && !q.state.error ? POLL_INTERVAL_MS : false,
  });
}
