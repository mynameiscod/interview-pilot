import {
  ANSWER_LIMITS,
  RtEvent,
  type InterviewSnapshot,
  type InterviewState,
  type InterviewSummary,
  type LiveQuestion,
  type LiveRound,
  type LiveTurn,
  type RoundTransitionEvent,
  type RtAck,
} from '@cbi/shared-types';
import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';
import { useInterviewsApi } from '../interviews/interviews-api';
import { useSocketFactory, type RoomSocket } from './realtime';

/** How long to wait for the server to acknowledge an event. */
export const ACK_TIMEOUT_MS = 10_000;
/** The server treats a room without heartbeats as disconnected. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Pause before retrying an answer the server was too busy to take. */
export const BUSY_RETRY_MS = 1_500;
const MAX_BUSY_RETRIES = 5;
const MAX_RECONNECT_DELAY_SEC = 30;

/** Once the room sees one of these, the interview is over for the candidate. */
export const FINISHED_STATES: readonly InterviewState[] = [
  'COMPLETING',
  'PROCESSING',
  'REPORT_READY',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
];

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** How a send attempt ended: stored, overtaken by the interview (stale) or refused. */
export type SendResult = 'sent' | 'stale' | 'rejected';

export type RoomProblem =
  'notFound' | 'notStarted' | 'signedOut' | 'stale' | 'sendFailed' | 'endFailed';

export interface RoomState {
  status: 'connecting' | 'connected' | 'reconnecting';
  /** At least one snapshot has arrived. */
  joined: boolean;
  title: string;
  state: InterviewState | null;
  rounds: LiveRound[];
  roundIdx: number;
  budgetMs: number;
  /** Interview time left as of `syncedAt` (a local Date.now() timestamp). */
  remainingMs: number;
  syncedAt: number;
  clockRunning: boolean;
  question: LiveQuestion | null;
  thinking: boolean;
  /** Every question seen so far, oldest first; answered ones carry the answer. */
  turns: LiveTurn[];
  sending: boolean;
  ending: boolean;
  problem: RoomProblem | null;
  /** Seconds until the next manual reconnect attempt, when one is scheduled. */
  retryInSec: number | null;
  finished: InterviewState | null;
}

type Action =
  | { type: 'status'; status: RoomState['status']; at: number }
  | { type: 'snapshot'; snapshot: InterviewSnapshot; at: number }
  | { type: 'thinking' }
  | { type: 'question'; question: LiveQuestion }
  | { type: 'transition'; event: RoundTransitionEvent }
  | { type: 'answered'; questionId: string; text: string }
  | { type: 'sending'; sending: boolean }
  | { type: 'ending'; ending: boolean }
  | { type: 'problem'; problem: RoomProblem | null }
  | { type: 'retry'; seconds: number | null }
  | { type: 'finished'; state: InterviewState };

export const initialRoomState: RoomState = {
  status: 'connecting',
  joined: false,
  title: '',
  state: null,
  rounds: [],
  roundIdx: 0,
  budgetMs: 0,
  remainingMs: 0,
  syncedAt: 0,
  clockRunning: false,
  question: null,
  thinking: false,
  turns: [],
  sending: false,
  ending: false,
  problem: null,
  retryInSec: null,
  finished: null,
};

const bySeq = (a: LiveTurn, b: LiveTurn) => a.seq - b.seq;

function withTurn(turns: LiveTurn[], turn: LiveTurn): LiveTurn[] {
  const rest = turns.filter((t) => t.seq !== turn.seq);
  return [...rest, turn].sort(bySeq);
}

function questionTurn(q: LiveQuestion): LiveTurn {
  return {
    seq: q.seq,
    questionId: q.questionId,
    roundIdx: q.roundIdx,
    question: q.text,
    answer: null,
  };
}

export function roomReducer(state: RoomState, action: Action): RoomState {
  switch (action.type) {
    case 'status': {
      if (action.status === 'connected' || !state.clockRunning) {
        return { ...state, status: action.status };
      }
      // The server stops the clock while nobody is connected; freeze it here too.
      const elapsed = Math.max(0, action.at - state.syncedAt);
      return {
        ...state,
        status: action.status,
        clockRunning: false,
        remainingMs: Math.max(0, state.remainingMs - elapsed),
        syncedAt: action.at,
      };
    }
    case 'snapshot': {
      const s = action.snapshot;
      const merged = new Map(state.turns.map((t) => [t.seq, t]));
      for (const turn of s.turns) {
        const known = merged.get(turn.seq);
        // Keep an answer this tab already has when the server copy predates it.
        merged.set(turn.seq, turn.answer === null && known?.answer ? known : turn);
      }
      if (s.currentQuestion && !merged.has(s.currentQuestion.seq)) {
        merged.set(s.currentQuestion.seq, questionTurn(s.currentQuestion));
      }
      // A question pushed while the join was in flight can be newer than the
      // snapshot: keep whichever question has the highest seq.
      const pushedIsNewer =
        state.question !== null && state.question.seq > (s.currentQuestion?.seq ?? s.lastSeq);
      const question = pushedIsNewer ? state.question : s.currentQuestion;
      return {
        ...state,
        joined: true,
        title: s.title,
        state: s.state,
        rounds: s.rounds,
        roundIdx: Math.max(s.roundIdx, question?.roundIdx ?? -1),
        budgetMs: s.budgetMs,
        remainingMs: s.remainingMs,
        syncedAt: action.at,
        clockRunning: s.clockRunning,
        question,
        thinking: pushedIsNewer ? false : s.thinking,
        turns: [...merged.values()].sort(bySeq),
      };
    }
    case 'thinking':
      return { ...state, thinking: true, question: null };
    case 'question':
      // Already shown (it also came in a snapshot, or twice): ignore anything not newer.
      if (state.turns.some((t) => t.seq >= action.question.seq)) return state;
      return {
        ...state,
        question: action.question,
        thinking: false,
        roundIdx: Math.max(state.roundIdx, action.question.roundIdx),
        turns: withTurn(state.turns, questionTurn(action.question)),
      };
    case 'transition': {
      const { fromRoundIdx, toRoundIdx } = action.event;
      return {
        ...state,
        roundIdx: toRoundIdx,
        rounds: state.rounds.map((round, idx) => {
          if (idx === fromRoundIdx && round.state === 'ACTIVE')
            return { ...round, state: 'COMPLETED' };
          if (idx === toRoundIdx) return { ...round, state: 'ACTIVE' };
          return round;
        }),
      };
    }
    case 'answered': {
      const turn = state.turns.find((t) => t.questionId === action.questionId);
      const turns = turn ? withTurn(state.turns, { ...turn, answer: action.text }) : state.turns;
      const wasCurrent = state.question?.questionId === action.questionId;
      return {
        ...state,
        turns,
        question: wasCurrent ? null : state.question,
        thinking: wasCurrent ? true : state.thinking,
      };
    }
    case 'sending':
      return { ...state, sending: action.sending };
    case 'ending':
      return { ...state, ending: action.ending };
    case 'problem':
      return { ...state, problem: action.problem };
    case 'retry':
      return { ...state, retryInSec: action.seconds };
    case 'finished':
      return { ...state, finished: action.state, sending: false };
  }
}

interface PendingAnswer {
  questionId: string;
  text: string;
  /** Idempotency key: kept until the server acknowledges, so resends are harmless. */
  clientMsgId: string;
  resolve: (result: SendResult) => void;
  attempt: number;
  inFlight: boolean;
  busyRetries: number;
}

function newClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}
const isOnline = () => navigator.onLine;
const alwaysOnline = () => true;

/**
 * The live text interview over Socket.IO: joins (and re-joins after every
 * reconnect with the highest seq already shown), keeps a heartbeat, follows
 * pushed questions and round changes, and sends answers with an idempotency
 * key that survives reconnects. No scores are ever received or shown.
 */
export function useInterviewRoom(sessionId: string) {
  const factory = useSocketFactory();
  const { manager } = useCandidateAuth();
  const api = useInterviewsApi();
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const online = useSyncExternalStore(subscribeOnline, isOnline, alwaysOnline);

  const pendingRef = useRef<PendingAnswer | null>(null);
  /** Sends the pending answer when connected and joined; set by the connection effect. */
  const flushRef = useRef<() => void>(() => undefined);
  const retryNowRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let joined = false;
    let everConnected = false;
    let maxSeq = 0;
    let failures = 0;
    let authRetries = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let countdown: ReturnType<typeof setInterval> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const socket: RoomSocket = factory({
      url: config.VITE_API_URL,
      token: manager.current?.accessToken ?? null,
    });

    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!disposed) fn();
      }, ms);
      timers.add(id);
    };

    const request = (event: string, payload: unknown) =>
      socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload) as Promise<RtAck>;

    function stopHeartbeat() {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (socket.connected) request(RtEvent.HEARTBEAT, { sessionId }).catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);
    }

    function clearRetry() {
      clearInterval(countdown);
      countdown = undefined;
      dispatch({ type: 'retry', seconds: null });
    }

    function reconnectNow() {
      if (disposed || socket.connected) return;
      clearRetry();
      const token = manager.current?.accessToken;
      if (token) socket.auth = { token };
      socket.connect();
    }

    /** Socket.IO stops retrying after a refused handshake; retry with a visible countdown. */
    function scheduleReconnect() {
      clearRetry();
      failures += 1;
      let seconds = Math.min(MAX_RECONNECT_DELAY_SEC, 2 ** failures);
      dispatch({ type: 'retry', seconds });
      countdown = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) reconnectNow();
        else dispatch({ type: 'retry', seconds });
      }, 1_000);
    }

    function finish(finalState: InterviewState) {
      stopHeartbeat();
      clearRetry();
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        pending.resolve('rejected');
      }
      dispatch({ type: 'finished', state: finalState });
    }

    function applySnapshot(snapshot: InterviewSnapshot) {
      maxSeq = Math.max(maxSeq, snapshot.lastSeq, ...snapshot.turns.map((t) => t.seq));
      dispatch({ type: 'snapshot', snapshot, at: Date.now() });
      if (FINISHED_STATES.includes(snapshot.state)) finish(snapshot.state);
    }

    function settle(pending: PendingAnswer, result: SendResult) {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      dispatch({ type: 'sending', sending: false });
      pending.resolve(result);
    }

    async function join() {
      if (disposed || !socket.connected) return;
      let ack: RtAck;
      try {
        ack = await request(RtEvent.JOIN, { sessionId, lastSeq: maxSeq });
      } catch {
        // No acknowledgement in time: try again while the connection holds.
        if (!disposed && socket.connected) later(() => void join(), 2_000);
        return;
      }
      if (disposed) return;
      if (!ack.ok) {
        if (ack.code === 'NOT_FOUND') dispatch({ type: 'problem', problem: 'notFound' });
        else if (ack.code === 'INVALID_STATE') dispatch({ type: 'problem', problem: 'notStarted' });
        else if (ack.code === 'UNAUTHENTICATED')
          dispatch({ type: 'problem', problem: 'signedOut' });
        else later(() => void join(), 2_000);
        return;
      }
      joined = true;
      if (ack.snapshot) applySnapshot(ack.snapshot);
      if (ack.snapshot && FINISHED_STATES.includes(ack.snapshot.state)) return;
      startHeartbeat();
      void flush();
    }

    async function flush() {
      const pending = pendingRef.current;
      if (!pending || pending.inFlight || !joined || !socket.connected || disposed) return;
      pending.inFlight = true;
      const attempt = ++pending.attempt;
      let ack: RtAck;
      try {
        ack = await request(RtEvent.ANSWER_TEXT, {
          sessionId,
          questionId: pending.questionId,
          text: pending.text,
          clientMsgId: pending.clientMsgId,
        });
      } catch {
        // Timed out: keep the answer (same id) and resend while connected or after reconnecting.
        if (attempt !== pending.attempt) return;
        pending.inFlight = false;
        if (socket.connected) later(() => void flush(), BUSY_RETRY_MS);
        return;
      }
      if (disposed || pendingRef.current !== pending) return;
      if (ack.ok) {
        settle(pending, 'sent');
        dispatch({ type: 'answered', questionId: pending.questionId, text: pending.text });
        return;
      }
      if (attempt !== pending.attempt) return; // A newer resend is on its way.
      pending.inFlight = false;
      switch (ack.code) {
        case 'BUSY':
          if (pending.busyRetries++ < MAX_BUSY_RETRIES) {
            later(() => void flush(), BUSY_RETRY_MS);
            return;
          }
          dispatch({ type: 'problem', problem: 'sendFailed' });
          settle(pending, 'rejected');
          return;
        case 'STALE_QUESTION':
          dispatch({ type: 'problem', problem: 'stale' });
          settle(pending, 'stale');
          void join();
          return;
        case 'INVALID_STATE':
          dispatch({ type: 'problem', problem: 'sendFailed' });
          settle(pending, 'rejected');
          void join();
          return;
        default:
          dispatch({ type: 'problem', problem: 'sendFailed' });
          settle(pending, 'rejected');
      }
    }

    const onConnect = () => {
      everConnected = true;
      failures = 0;
      authRetries = 0;
      clearRetry();
      dispatch({ type: 'status', status: 'connected', at: Date.now() });
      void join();
    };

    const onDisconnect = (reason: string) => {
      joined = false;
      stopHeartbeat();
      if (pendingRef.current) pendingRef.current.inFlight = false;
      if (disposed) return;
      dispatch({ type: 'status', status: 'reconnecting', at: Date.now() });
      // A server-side disconnect is not retried by Socket.IO itself.
      if (reason === 'io server disconnect' || socket.active === false) scheduleReconnect();
    };

    const onConnectError = async (err: Error) => {
      if (disposed) return;
      dispatch({
        type: 'status',
        status: everConnected ? 'reconnecting' : 'connecting',
        at: Date.now(),
      });
      if (err?.message === 'TOKEN_EXPIRED' || err?.message === 'UNAUTHENTICATED') {
        if (authRetries++ >= 2) {
          dispatch({ type: 'problem', problem: 'signedOut' });
          return;
        }
        let session;
        try {
          session = await manager.refresh();
        } catch {
          if (!disposed) scheduleReconnect(); // Network trouble: try again shortly.
          return;
        }
        if (disposed) return;
        if (!session) {
          dispatch({ type: 'problem', problem: 'signedOut' });
          return;
        }
        socket.auth = { token: session.accessToken };
        socket.connect();
        return;
      }
      if (socket.active === false) scheduleReconnect();
    };

    const onThinking = () => dispatch({ type: 'thinking' });
    const onQuestion = (question: LiveQuestion) => {
      maxSeq = Math.max(maxSeq, question.seq);
      dispatch({ type: 'question', question });
    };
    const onTransition = (event: RoundTransitionEvent) => dispatch({ type: 'transition', event });
    const onCompleted = (snapshot: InterviewSnapshot | undefined) => {
      if (snapshot?.state) applySnapshot(snapshot);
      else finish('PROCESSING');
    };
    const onDraining = () => dispatch({ type: 'status', status: 'reconnecting', at: Date.now() });

    const listeners: [string, (...args: never[]) => void][] = [
      ['connect', onConnect],
      ['disconnect', onDisconnect],
      ['connect_error', onConnectError],
      [RtEvent.THINKING, onThinking],
      [RtEvent.QUESTION, onQuestion],
      [RtEvent.ROUND_TRANSITION, onTransition],
      [RtEvent.COMPLETED, onCompleted],
      [RtEvent.DRAINING, onDraining],
    ];
    // Registered once, before the first connect: Socket.IO keeps them across
    // reconnects, so every join already has its listeners in place (the server
    // may push the next question before it acknowledges the join).
    for (const [event, listener] of listeners) socket.on(event, listener);

    flushRef.current = () => void flush();
    retryNowRef.current = reconnectNow;
    socket.connect();

    return () => {
      disposed = true;
      stopHeartbeat();
      clearInterval(countdown);
      for (const id of timers) clearTimeout(id);
      for (const [event, listener] of listeners) socket.off(event, listener);
      socket.disconnect();
      flushRef.current = () => undefined;
      retryNowRef.current = () => undefined;
    };
  }, [factory, manager, sessionId]);

  /** Coming back online: do not wait for the next scheduled retry. */
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) retryNowRef.current();
    wasOnline.current = online;
  }, [online]);

  const sendAnswer = useCallback((questionId: string, text: string): Promise<SendResult> => {
    const trimmed = text.trim();
    if (pendingRef.current || !trimmed || trimmed.length > ANSWER_LIMITS.maxChars) {
      return Promise.resolve('rejected');
    }
    return new Promise<SendResult>((resolve) => {
      pendingRef.current = {
        questionId,
        text: trimmed,
        clientMsgId: newClientMsgId(),
        resolve,
        attempt: 0,
        inFlight: false,
        busyRetries: 0,
      };
      dispatch({ type: 'problem', problem: null });
      dispatch({ type: 'sending', sending: true });
      flushRef.current();
    });
  }, []);

  const end = useCallback(async (): Promise<InterviewSummary | null> => {
    dispatch({ type: 'problem', problem: null });
    dispatch({ type: 'ending', ending: true });
    try {
      const ended = await api.end(sessionId);
      dispatch({ type: 'finished', state: ended.state });
      return ended;
    } catch {
      dispatch({ type: 'problem', problem: 'endFailed' });
      return null;
    } finally {
      dispatch({ type: 'ending', ending: false });
    }
  }, [api, sessionId]);

  const retryNow = useCallback(() => retryNowRef.current(), []);
  const dismissProblem = useCallback(() => dispatch({ type: 'problem', problem: null }), []);

  const connection: ConnectionStatus =
    state.status !== 'connected' && !online ? 'offline' : state.status;

  return { ...state, connection, sendAnswer, end, retryNow, dismissProblem };
}

export type InterviewRoom = ReturnType<typeof useInterviewRoom>;
