import { DESIGN_LIMITS, type DesignWorkspace, type SaveDesignBody } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { designKeys, useDesignApi } from './design-api';

/**
 * - saved: the server has the design as shown
 * - dirty: changed; saved a few seconds after the last change (or when leaving)
 * - saving / retrying: being saved, or the last save failed and is retried
 * - closed: the server no longer takes changes (submitted, or not live)
 */
export type DesignSaveStatus = 'saved' | 'dirty' | 'saving' | 'retrying' | 'closed';

const keyOf = (body: SaveDesignBody) => JSON.stringify(body);
const errorCode = (err: unknown) => (err instanceof ApiClientError ? err.code : null);

/**
 * One design question's workspace: loads the prompt and saved design, keeps
 * the candidate's changes, autosaves them (debounced, and when the tab is
 * hidden or the workspace closes, retrying quietly), and submits.
 */
export function useDesignWorkspace(
  sessionId: string,
  questionId: string,
  onSubmitted?: (workspace: DesignWorkspace) => void,
) {
  const api = useDesignApi();
  const query = useQuery({
    queryKey: designKeys.workspace(sessionId, questionId),
    queryFn: () => api.workspace(sessionId, questionId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = query.data;
  const [draft, setDraft] = useState<SaveDesignBody | null>(null);
  const current: SaveDesignBody | null =
    draft ?? (data ? { notes: data.notes, diagram: data.diagram } : null);
  const [status, setStatus] = useState<DesignSaveStatus>('saved');
  const [submittedAt, setSubmittedAt] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<'submitFailed' | 'closed' | null>(null);
  const submitted =
    (submittedAt === undefined ? (data?.submittedAt ?? null) : submittedAt) !== null;

  const latest = useRef<SaveDesignBody | null>(null);
  const saved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const closed = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    if (data && saved.current === null) saved.current = keyOf(data);
    if (data?.submittedAt) closed.current = true;
  }, [data]);
  useEffect(() => {
    latest.current = current;
  });

  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const schedule = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => void saveRef.current(), DESIGN_LIMITS.autosaveMs);
  }, [clearTimer]);

  const saveNow = useCallback(async () => {
    clearTimer();
    const body = latest.current;
    if (!body || closed.current) return;
    const key = keyOf(body);
    if (key === saved.current) {
      if (mounted.current) setStatus('saved');
      return;
    }
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    if (mounted.current) setStatus('saving');
    try {
      await api.save(sessionId, questionId, body);
      saved.current = key;
      if (!mounted.current) return;
      const now = latest.current;
      if (now && keyOf(now) !== key) {
        setStatus('dirty');
        schedule();
      } else {
        setStatus('saved');
      }
    } catch (err) {
      if (errorCode(err) === 'INVALID_STATE') {
        closed.current = true;
        if (mounted.current) setStatus('closed');
      } else if (mounted.current) {
        setStatus('retrying');
        schedule();
      }
    } finally {
      inFlight.current = false;
      if (again.current && mounted.current) {
        again.current = false;
        void saveRef.current();
      }
    }
  }, [api, sessionId, questionId, clearTimer, schedule]);
  useEffect(() => {
    saveRef.current = saveNow;
  }, [saveNow]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void saveNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      mounted.current = false;
      const pending = timer.current !== undefined;
      clearTimer();
      const body = latest.current;
      if (pending && body && !closed.current && keyOf(body) !== saved.current) {
        api.save(sessionId, questionId, body).catch(() => undefined);
      }
    };
  }, [api, sessionId, questionId, saveNow, clearTimer]);

  function edit(next: SaveDesignBody) {
    if (submitted) return;
    setDraft(next);
    latest.current = next;
    if (closed.current) return;
    if (keyOf(next) === saved.current) {
      clearTimer();
      setStatus('saved');
      return;
    }
    if (status !== 'retrying') setStatus('dirty');
    schedule();
  }

  async function submit(): Promise<boolean> {
    const body = latest.current;
    if (!body || busy || submitted) return false;
    clearTimer();
    setBusy(true);
    setProblem(null);
    try {
      const ws = await api.submit(sessionId, questionId, body);
      saved.current = keyOf(body);
      closed.current = true;
      setStatus('saved');
      setSubmittedAt(ws.submittedAt);
      onSubmitted?.(ws);
      return true;
    } catch (err) {
      if (errorCode(err) === 'INVALID_STATE') {
        const fresh = await query.refetch();
        if (fresh.data?.submittedAt) {
          closed.current = true;
          setSubmittedAt(fresh.data.submittedAt);
          onSubmitted?.(fresh.data);
          return true;
        }
        setProblem('closed');
      } else {
        setProblem('submitFailed');
      }
      if (mounted.current) void saveNow();
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return {
    query,
    prompt: data?.prompt ?? null,
    design: current,
    status: submitted ? ('closed' as const) : status,
    submitted,
    busy,
    problem,
    dismissProblem: () => setProblem(null),
    setNotes: (notes: SaveDesignBody['notes']) => current && edit({ ...current, notes }),
    setDiagram: (diagram: SaveDesignBody['diagram']) => current && edit({ ...current, diagram }),
    saveNow,
    submit,
  };
}
