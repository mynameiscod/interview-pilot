import type { DesignWorkspace, SaveDesignBody } from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

const path = (sessionId: string, questionId: string) =>
  `/interviews/${encodeURIComponent(sessionId)}/design/${encodeURIComponent(questionId)}`;

function designApi(api: ApiClient) {
  return {
    /** The prompt, the saved notes and diagram, and whether it was submitted. */
    workspace: (sessionId: string, questionId: string) =>
      api.get<DesignWorkspace>(path(sessionId, questionId)),
    /** Autosave. 409 once submitted (or the interview is not live). */
    save: (sessionId: string, questionId: string, body: SaveDesignBody) =>
      api.put<DesignWorkspace>(path(sessionId, questionId), body),
    /** Submits the design: this answers the design question; the probes follow. */
    submit: (sessionId: string, questionId: string, body: SaveDesignBody) =>
      api.post<DesignWorkspace>(`${path(sessionId, questionId)}/submit`, body),
  };
}

export type DesignApi = ReturnType<typeof designApi>;

export function useDesignApi(): DesignApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => designApi(manager.api), [manager]);
}

export const designKeys = {
  workspace: (sessionId: string, questionId: string) =>
    ['interviews', sessionId, 'design', questionId] as const,
};
