import type { CodingWorkspace, SaveCodeBody } from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

const path = (sessionId: string, questionId: string) =>
  `/interviews/${encodeURIComponent(sessionId)}/coding/${encodeURIComponent(questionId)}`;

function codingApi(api: ApiClient) {
  return {
    /** The problem (visible tests only), the saved code and any run or submission. */
    workspace: (sessionId: string, questionId: string) =>
      api.get<CodingWorkspace>(path(sessionId, questionId)),
    /** Autosave. 409 once submitted (or the interview is not live), 413 when too long. */
    save: (sessionId: string, questionId: string, body: SaveCodeBody) =>
      api.put<CodingWorkspace>(path(sessionId, questionId), body),
    /** Runs the visible tests (the code is saved too). 503 JUDGE_UNAVAILABLE, 429 when too often. */
    run: (sessionId: string, questionId: string, body: SaveCodeBody) =>
      api.post<CodingWorkspace>(`${path(sessionId, questionId)}/run`, body),
    /** Submits the solution: this answers the coding question. Works without the judge. */
    submit: (sessionId: string, questionId: string, body: SaveCodeBody) =>
      api.post<CodingWorkspace>(`${path(sessionId, questionId)}/submit`, body),
  };
}

export type CodingApi = ReturnType<typeof codingApi>;

export function useCodingApi(): CodingApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => codingApi(manager.api), [manager]);
}

export const codingKeys = {
  workspace: (sessionId: string, questionId: string) =>
    ['interviews', sessionId, 'coding', questionId] as const,
};
