import type { InterviewSnapshot, LiveQuestion, RtAck } from '@cbi/shared-types';
import { act } from '@testing-library/react';
import type { RoomSocket, SocketFactory, SocketListener } from '../features/room/realtime';

type AnyListener = (...args: unknown[]) => void;
type AckHandler = (payload: unknown) => RtAck | Promise<RtAck>;

/**
 * An in-memory Socket.IO stand-in for room tests. `ackHandlers` answer
 * client events (`emitWithAck`); a missing handler never acknowledges.
 * `serverConnect`, `serverDisconnect` and `push` play the server's part.
 */
export class FakeSocket implements RoomSocket {
  connected = false;
  active: boolean | undefined = undefined;
  auth: Record<string, unknown>;
  /** Every client → server event, in order. */
  readonly emitted: { event: string; payload: unknown }[] = [];
  connectCalls = 0;
  ackHandlers: Record<string, AckHandler> = {};
  private listeners = new Map<string, Set<AnyListener>>();

  constructor(
    auth: Record<string, unknown>,
    private readonly opts: { autoConnect: boolean },
  ) {
    this.auth = auth;
  }

  on(event: string, listener: SocketListener) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as unknown as AnyListener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener?: SocketListener) {
    if (!listener) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(listener as unknown as AnyListener);
    return this;
  }

  once(event: string, listener: SocketListener) {
    const wrapped = ((...args: unknown[]) => {
      this.off(event, wrapped as unknown as SocketListener);
      (listener as unknown as AnyListener)(...args);
    }) as unknown as SocketListener;
    return this.on(event, wrapped);
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }

  timeout(_ms: number) {
    return {
      emitWithAck: (event: string, payload: unknown): Promise<unknown> => {
        this.emitted.push({ event, payload });
        const handler = this.ackHandlers[event];
        if (!handler) return new Promise(() => undefined);
        return Promise.resolve(handler(payload));
      },
    };
  }

  connect() {
    this.connectCalls += 1;
    if (this.opts.autoConnect && !this.connected) {
      queueMicrotask(() => act(() => this.fire('connect')));
      this.connected = true;
    }
    return this;
  }

  disconnect() {
    this.connected = false;
    return this;
  }

  /** Events of one kind the client sent. */
  sent(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }

  async serverConnect() {
    this.connected = true;
    await act(async () => this.fire('connect'));
  }

  async serverDisconnect(reason = 'transport close') {
    this.connected = false;
    await act(async () => this.fire('disconnect', reason));
  }

  async push(event: string, payload?: unknown) {
    await act(async () => this.fire(event, payload));
  }

  private fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

/** Records every socket the room opens; `last` is the current one. */
export function fakeSocketFactory(
  opts: { autoConnect?: boolean; setup?: (s: FakeSocket) => void } = {},
) {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = ({ token }) => {
    const socket = new FakeSocket({ token }, { autoConnect: opts.autoConnect ?? true });
    opts.setup?.(socket);
    sockets.push(socket);
    return socket;
  };
  return {
    factory,
    sockets,
    get last(): FakeSocket {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('No socket was opened');
      return socket;
    },
  };
}

/** A socket factory that never connects: pages that open the room without testing it. */
export const inertSocketFactory: SocketFactory = ({ token }) =>
  new FakeSocket({ token }, { autoConnect: false });

const NOW = '2026-09-20T10:05:00.000Z';

export function makeQuestion(overrides: Partial<LiveQuestion> = {}): LiveQuestion {
  return {
    questionId: 'q1',
    seq: 1,
    text: 'Tell me about a project you are proud of.',
    roundIdx: 0,
    roundType: 'INTRO',
    isFollowUp: false,
    askedAt: NOW,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<InterviewSnapshot> = {}): InterviewSnapshot {
  const currentQuestion =
    overrides.currentQuestion === undefined ? makeQuestion() : overrides.currentQuestion;
  return {
    sessionId: 'int1',
    state: 'ACTIVE',
    mode: 'TEXT',
    voiceEnabled: false,
    language: 'auto',
    title: 'Backend Developer',
    rounds: [
      { type: 'INTRO', state: 'ACTIVE', durationSec: 300 },
      { type: 'TECHNICAL', state: 'PENDING', durationSec: 1200 },
    ],
    roundIdx: 0,
    budgetMs: 1_500_000,
    remainingMs: 1_200_000,
    clockRunning: true,
    answeredCount: 0,
    currentQuestion,
    thinking: false,
    turns: currentQuestion
      ? [
          {
            seq: currentQuestion.seq,
            questionId: currentQuestion.questionId,
            roundIdx: currentQuestion.roundIdx,
            question: currentQuestion.text,
            answer: null,
            answerSource: null,
          },
        ]
      : [],
    lastSeq: currentQuestion?.seq ?? 0,
    serverTime: NOW,
    ...overrides,
  };
}
