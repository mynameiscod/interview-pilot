import type {
  CertificateStatus,
  CertificateVerification,
  CreateDrillBody,
  DrillResult,
  InterviewSummary,
  PlanItemState,
  ProgressOverview,
  UpdateGoalsBody,
  UpdatePlanItemBody,
} from '@cbi/shared-types';
import type { ApiClient, SessionManager } from '@cbi/web-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { downloadPdf } from '../reports/reports-api';

/** How often a drill result is re-read while it is being evaluated. */
export const DRILL_POLL_MS = 3_000;

function progressApi(api: ApiClient) {
  const enc = encodeURIComponent;
  return {
    overview: () => api.get<ProgressOverview>('/users/me/progress'),
    updateGoals: (body: UpdateGoalsBody) =>
      api.put<ProgressOverview>('/users/me/progress/goals', body),
    updatePlanItem: (body: UpdatePlanItemBody) =>
      api.put<PlanItemState>('/users/me/progress/plan-items', body),
    createDrill: (body: CreateDrillBody) => api.post<InterviewSummary>('/drills', body),
    drill: (id: string) => api.get<DrillResult>(`/drills/${enc(id)}`),
    certificate: (sessionId: string) =>
      api.get<CertificateStatus>(`/reports/${enc(sessionId)}/certificate`),
    issueCertificate: (sessionId: string) =>
      api.post<CertificateStatus>(`/reports/${enc(sessionId)}/certificate`),
    /** Public: no sign-in needed. */
    verifyCertificate: (code: string) =>
      api.get<CertificateVerification>(`/certificates/${enc(code)}`),
    /** Public: the signed token from an email link. */
    unsubscribe: (token: string) =>
      api.post<{ unsubscribed: true }>('/email/unsubscribe', { token }),
  };
}

export type ProgressApi = ReturnType<typeof progressApi>;

export function useProgressApi(): ProgressApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => progressApi(manager.api), [manager]);
}

export const progressKeys = {
  overview: ['progress'] as const,
  drill: (id: string) => ['drills', id] as const,
  certificate: (sessionId: string) => ['reports', sessionId, 'certificate'] as const,
  verify: (code: string) => ['certificates', code] as const,
};

export function useProgress() {
  const api = useProgressApi();
  return useQuery({ queryKey: progressKeys.overview, queryFn: api.overview });
}

/** Ticks a plan item; the checklist updates at once and rolls back if the save fails. */
export function useUpdatePlanItem() {
  const api = useProgressApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePlanItemBody) => api.updatePlanItem(body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: progressKeys.overview });
      const previous = queryClient.getQueryData<ProgressOverview>(progressKeys.overview);
      queryClient.setQueryData<ProgressOverview>(progressKeys.overview, (old) =>
        old?.plan
          ? {
              ...old,
              plan: {
                ...old.plan,
                items: old.plan.items.map((i) =>
                  i.id === body.itemId ? { ...i, done: body.done } : i,
                ),
                doneCount: old.plan.items.filter((i) => (i.id === body.itemId ? body.done : i.done))
                  .length,
              },
            }
          : old,
      );
      return { previous };
    },
    onError: (_err, _body, context) => {
      if (context?.previous) queryClient.setQueryData(progressKeys.overview, context.previous);
    },
    // Badges (all plan items done) are awarded by the server.
    onSettled: () => queryClient.invalidateQueries({ queryKey: progressKeys.overview }),
  });
}

export function useUpdateGoals() {
  const api = useProgressApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGoalsBody) => api.updateGoals(body),
    onSuccess: (overview) => queryClient.setQueryData(progressKeys.overview, overview),
  });
}

export function useCreateDrill() {
  const api = useProgressApi();
  return useMutation({ mutationFn: (body: CreateDrillBody) => api.createDrill(body) });
}

const drillSettled = (d: DrillResult | undefined) =>
  Boolean(d && ['REPORT_READY', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(d.state));

/** A drill's result, re-read until its evaluation has finished. */
export function useDrillResult(id: string) {
  const api = useProgressApi();
  return useQuery({
    queryKey: progressKeys.drill(id),
    queryFn: () => api.drill(id),
    refetchInterval: (q) => (drillSettled(q.state.data) ? false : DRILL_POLL_MS),
  });
}

export function useCertificate(sessionId: string, enabled: boolean) {
  const api = useProgressApi();
  return useQuery({
    queryKey: progressKeys.certificate(sessionId),
    queryFn: () => api.certificate(sessionId),
    enabled,
    // Re-read while the PDF is being prepared.
    refetchInterval: (q) =>
      q.state.data?.certificate && !q.state.data.certificate.pdfReady ? DRILL_POLL_MS : false,
  });
}

export function useIssueCertificate(sessionId: string) {
  const api = useProgressApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.issueCertificate(sessionId),
    onSuccess: (status) => queryClient.setQueryData(progressKeys.certificate(sessionId), status),
  });
}

export function useCertificateVerification(code: string) {
  const api = useProgressApi();
  return useQuery({
    queryKey: progressKeys.verify(code),
    queryFn: () => api.verifyCertificate(code),
    // Unknown codes answer 404; retrying will not change that.
    retry: false,
  });
}

export function useUnsubscribe() {
  const api = useProgressApi();
  return useMutation({ mutationFn: (token: string) => api.unsubscribe(token) });
}

export function downloadCertificatePdf(manager: SessionManager, sessionId: string, code: string) {
  return downloadPdf(
    manager,
    `/reports/${encodeURIComponent(sessionId)}/certificate/pdf`,
    `readiness-certificate-${code}.pdf`,
  );
}
