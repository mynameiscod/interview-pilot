import {
  CODING_LIMITS,
  type CodeRunResult,
  type CodingLanguage,
  type CodingSubmission,
  type SaveCodeBody,
} from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { codingKeys, useCodingApi } from './coding-api';

/**
 * - saved: the server has the code as shown
 * - dirty: edited; saved a few seconds after typing stops (or on blur)
 * - saving: being saved
 * - retrying: the last save failed; tried again shortly
 * - tooLong: over the size limit; not saved until shortened
 * - closed: the server no longer takes changes (submitted, or the interview is not live)
 */
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'retrying' | 'tooLong' | 'closed';

export type RunProblem = 'rateLimited' | 'runFailed' | 'submitFailed' | 'closed';

const encoder = new TextEncoder();
export const codeBytes = (code: string) => encoder.encode(code).length;

const keyOf = (body: SaveCodeBody) => `${body.language}\n${body.code}`;
const errorCode = (err: unknown) => (err instanceof ApiClientError ? err.code : null);

/**
 * One coding question's workspace: loads the problem and saved code, keeps
 * the candidate's edits, autosaves them (debounced, on blur and when the tab
 * is hidden, retrying quietly), and runs or submits the code. Typing is never
 * blocked by saving.
 */
export function useCodingWorkspace(
  sessionId: string,
  questionId: string,
  onSubmitted?: (submission: CodingSubmission) => void,
) {
  const api = useCodingApi();
  const query = useQuery({
    queryKey: codingKeys.workspace(sessionId, questionId),
    queryFn: () => api.workspace(sessionId, questionId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = query.data;

  const [draft, setDraft] = useState<SaveCodeBody | null>(null);
  const current: SaveCodeBody | null =
    draft ?? (data ? { language: data.language, code: data.code } : null);
  const [lastRun, setLastRun] = useState<CodeRunResult | null | undefined>(undefined);
  const [submission, setSubmission] = useState<CodingSubmission | null | undefined>(undefined);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [busy, setBusy] = useState<'run' | 'submit' | null>(null);
  const [judgeDown, setJudgeDown] = useState(false);
  const [problem, setProblem] = useState<RunProblem | null>(null);

  const shownRun = lastRun === undefined ? (data?.lastRun ?? null) : lastRun;
  const shownSubmission = submission === undefined ? (data?.submission ?? null) : submission;
  const submitted = shownSubmission !== null;
  const tooLong = current ? codeBytes(current.code) > CODING_LIMITS.maxCodeBytes : false;

  const latest = useRef<SaveCodeBody | null>(null);
  const saved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const closed = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    // The server copy is what was saved last.
    if (data && saved.current === null) saved.current = keyOf(data);
  }, [data]);
  useEffect(() => {
    latest.current = current;
  });
  useEffect(() => {
    if (shownSubmission) closed.current = true;
  }, [shownSubmission]);

  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  /** The latest saveNow, for timers set before it was (re)created. */
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const schedule = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => void saveRef.current(), CODING_LIMITS.autosaveMs);
  }, [clearTimer]);

  const saveNow = useCallback(async () => {
    clearTimer();
    const body = latest.current;
    if (!body || closed.current) return;
    if (codeBytes(body.code) > CODING_LIMITS.maxCodeBytes) {
      if (mounted.current) setStatus('tooLong');
      return;
    }
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
      const code = errorCode(err);
      if (code === 'INVALID_STATE') {
        closed.current = true;
        if (mounted.current) setStatus('closed');
      } else if (code === 'PAYLOAD_TOO_LARGE') {
        if (mounted.current) setStatus('tooLong');
      } else if (mounted.current) {
        // Network trouble or a server hiccup: keep the code here and try again quietly.
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

  /** Saves when the tab is hidden, and whatever is unsaved when the workspace closes. */
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

  function edit(next: SaveCodeBody) {
    if (submitted) return;
    setDraft(next);
    latest.current = next;
    if (closed.current) return;
    if (codeBytes(next.code) > CODING_LIMITS.maxCodeBytes) {
      clearTimer();
      setStatus('tooLong');
      return;
    }
    if (keyOf(next) === saved.current) {
      clearTimer();
      setStatus('saved');
      return;
    }
    // A failed save keeps saying so (and its retry stays scheduled) until one succeeds.
    if (status !== 'retrying') setStatus('dirty');
    clearTimer();
    schedule();
  }

  const setCode = (code: string) => current && edit({ language: current.language, code });

  /** Changes language, loading that language's starter code. */
  const setLanguage = (language: CodingLanguage) =>
    edit({ language, code: data?.problem.starterCode[language] ?? '' });

  /** The current code differs from its starter (switching language would replace it). */
  const edited =
    current !== null &&
    current.code.trim() !== '' &&
    current.code !== (data?.problem.starterCode[current.language] ?? '');

  async function run() {
    const body = latest.current;
    if (!body || busy || submitted || tooLong) return;
    clearTimer();
    setBusy('run');
    setProblem(null);
    try {
      const ws = await api.run(sessionId, questionId, body);
      saved.current = keyOf(body);
      setLastRun(ws.lastRun);
      setJudgeDown(false);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'JUDGE_UNAVAILABLE') {
        // The code was saved anyway; the candidate keeps working.
        saved.current = keyOf(body);
        setJudgeDown(true);
      } else if (code === 'RATE_LIMITED') {
        setProblem('rateLimited');
      } else {
        setProblem('runFailed');
      }
    } finally {
      if (mounted.current) {
        setBusy(null);
        const now = latest.current;
        if (now && keyOf(now) === saved.current) setStatus('saved');
        else void saveNow();
      }
    }
  }

  async function submit(): Promise<boolean> {
    const body = latest.current;
    if (!body || busy || submitted || tooLong) return false;
    clearTimer();
    setBusy('submit');
    setProblem(null);
    try {
      const ws = await api.submit(sessionId, questionId, body);
      saved.current = keyOf(body);
      closed.current = true;
      setStatus('saved');
      if (ws.lastRun) setLastRun(ws.lastRun);
      setSubmission(ws.submission);
      if (ws.submission) onSubmitted?.(ws.submission);
      return true;
    } catch (err) {
      if (errorCode(err) === 'INVALID_STATE') {
        // Already submitted (another tab) or no longer open: show what the server has.
        const fresh = await query.refetch();
        const done = fresh.data?.submission ?? null;
        if (done) {
          closed.current = true;
          setSubmission(done);
          onSubmitted?.(done);
          return true;
        }
        setProblem('closed');
      } else {
        setProblem('submitFailed');
      }
      if (mounted.current) void saveNow();
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return {
    query,
    problemData: data?.problem ?? null,
    language: current?.language ?? null,
    code: current?.code ?? '',
    status,
    edited,
    tooLong,
    busy,
    judgeDown,
    dismissJudgeDown: () => setJudgeDown(false),
    problem,
    dismissProblem: () => setProblem(null),
    lastRun: shownRun,
    submission: shownSubmission,
    setCode,
    setLanguage,
    saveNow,
    run,
    submit,
  };
}

export type CodingWorkspaceState = ReturnType<typeof useCodingWorkspace>;
