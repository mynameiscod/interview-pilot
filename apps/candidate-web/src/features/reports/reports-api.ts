import {
  API_V1_PREFIX,
  type CompareResult,
  type FeedbackBody,
  type FeedbackSummary,
  type ProcessingProgress,
  type ReportHistoryItem,
  type ReportSummary,
} from '@cbi/shared-types';
import { ApiClientError, type ApiClient, type SessionManager } from '@cbi/web-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';

/** How often the completion screen re-checks evaluation progress. */
export const PROGRESS_POLL_MS = 3_000;

/** The report section people land on from "Rate your interview" links. */
export const FEEDBACK_ANCHOR = 'feedback';

function reportsApi(api: ApiClient) {
  const enc = encodeURIComponent;
  return {
    getReport: (id: string) => api.get<ReportSummary>(`/reports/${enc(id)}`),
    history: () => api.get<ReportHistoryItem[]>('/reports'),
    compare: (ids: string[]) =>
      api.get<CompareResult>(`/reports/compare?sessions=${ids.map(enc).join(',')}`),
    progress: (id: string) => api.get<ProcessingProgress>(`/interviews/${enc(id)}/progress`),
    getFeedback: (id: string) => api.get<FeedbackSummary | null>(`/feedback/${enc(id)}`),
    saveFeedback: (body: FeedbackBody) => api.post<FeedbackSummary>('/feedback', body),
  };
}

export type ReportsApi = ReturnType<typeof reportsApi>;

export function useReportsApi(): ReportsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => reportsApi(manager.api), [manager]);
}

export const reportKeys = {
  report: (id: string) => ['reports', id] as const,
  history: ['reports', 'history'] as const,
  compare: (ids: string[]) => ['reports', 'compare', ...ids] as const,
  progress: (id: string) => ['interviews', id, 'progress'] as const,
  feedback: (id: string) => ['feedback', id] as const,
};

export function useReport(id: string) {
  const api = useReportsApi();
  return useQuery({ queryKey: reportKeys.report(id), queryFn: () => api.getReport(id) });
}

export function useReportHistory() {
  const api = useReportsApi();
  return useQuery({ queryKey: reportKeys.history, queryFn: api.history });
}

export function useCompare(ids: string[], enabled: boolean) {
  const api = useReportsApi();
  return useQuery({
    queryKey: reportKeys.compare(ids),
    queryFn: () => api.compare(ids),
    enabled,
    // A 400 (different roles) will not fix itself.
    retry: false,
  });
}

const progressDone = (p: ProcessingProgress | undefined) =>
  Boolean(p && (p.reportReady || p.status === 'FAILED'));

/** Polls evaluation progress until the report is ready or the pipeline failed. */
export function useProcessingProgress(id: string, enabled: boolean) {
  const api = useReportsApi();
  return useQuery({
    queryKey: reportKeys.progress(id),
    queryFn: () => api.progress(id),
    enabled,
    refetchInterval: (q) => (progressDone(q.state.data) ? false : PROGRESS_POLL_MS),
  });
}

export function useFeedback(id: string) {
  const api = useReportsApi();
  return useQuery({ queryKey: reportKeys.feedback(id), queryFn: () => api.getFeedback(id) });
}

export function useSaveFeedback(id: string) {
  const api = useReportsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedbackBody) => api.saveFeedback(body),
    onSuccess: (saved) => queryClient.setQueryData(reportKeys.feedback(id), saved),
  });
}

/** The PDF is still being rendered (the API answers 409 INVALID_STATE). */
export class PdfNotReadyError extends Error {
  constructor() {
    super('The PDF is still being prepared');
    this.name = 'PdfNotReadyError';
  }
}

function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? fallback;
}

/**
 * Downloads the report PDF. The API client only understands JSON, so this
 * fetches the bytes directly with the session's bearer token (refreshing it
 * once on 401) and saves them through an object URL.
 */
export async function downloadReportPdf(manager: SessionManager, sessionId: string) {
  const url = `${config.VITE_API_URL}${API_V1_PREFIX}/reports/${encodeURIComponent(sessionId)}/pdf`;
  const send = (token: string | null) =>
    fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'application/pdf',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  const token = manager.current?.accessToken ?? null;
  let response = await send(token);
  if (response.status === 401 && token) {
    const fresh = (await manager.refresh())?.accessToken ?? null;
    if (fresh) response = await send(fresh);
  }
  if (response.status === 409) throw new PdfNotReadyError();
  if (!response.ok) {
    throw new ApiClientError('INVALID_RESPONSE', 'Could not download the PDF', response.status);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileNameFrom(
    response.headers.get('Content-Disposition'),
    `readiness-report-${sessionId}.pdf`,
  );
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
