import type { RtAck } from '@cbi/shared-types';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import {
  fakeSocketFactory,
  makeQuestion,
  makeSnapshot,
  type FakeSocket,
} from '../../test/fake-socket';
import { makeInterview } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const ROOM = '/app/interviews/int1/room';

type AnswerPayload = { questionId: string; text: string; clientMsgId: string };

async function openRoom(
  opts: {
    snapshot?: Parameters<typeof makeSnapshot>[0];
    setup?: (socket: FakeSocket) => void;
    handlers?: Parameters<typeof fakeApi>[0];
  } = {},
) {
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers['interview:join'] = () => ({
        ok: true,
        snapshot: makeSnapshot(opts.snapshot),
      });
      opts.setup?.(socket);
    },
  });
  const api = fakeApi({ ...signedIn, ...opts.handlers });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  return { ...result, sockets };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.useRealTimers());

describe('interview room', () => {
  it('joins with the access token and shows the current question and round progress', async () => {
    const { sockets } = await openRoom();

    expect(
      await screen.findByText('Tell me about a project you are proud of.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Backend Developer' })).toBeVisible();
    expect(sockets.last.auth).toEqual({ token: 'access-token' });
    expect(sockets.last.sent('interview:join')).toEqual([{ sessionId: 'int1', lastSeq: 0 }]);

    const rounds = screen.getByRole('list', { name: 'Interview rounds' });
    const items = within(rounds).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).toHaveTextContent('Introduction');
    expect(items[1]).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
    // The main navigation is not part of the focus layout.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  it('sends an answer with a client message id and clears the box only after the ack', async () => {
    let release!: (ack: RtAck) => void;
    const { sockets } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['answer:text'] = () => new Promise<RtAck>((r) => (release = r));
      },
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Your answer' });

    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled();
    await user.type(box, 'I built a REST API for a college fest.');
    expect(sessionStorage.getItem('cbi.room.draft.int1.q1')).toBe(
      'I built a REST API for a college fest.',
    );
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    const [sent] = sockets.last.sent('answer:text') as [AnswerPayload];
    expect(sent).toMatchObject({
      sessionId: 'int1',
      questionId: 'q1',
      text: 'I built a REST API for a college fest.',
    });
    expect(sent.clientMsgId).toMatch(/^[\w-]{8,64}$/);
    expect(box).toHaveValue('I built a REST API for a college fest.');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();

    await act(async () => release({ ok: true }));

    expect(await screen.findByText('Preparing the next question…')).toBeInTheDocument();
    expect(box).toHaveValue('');
    expect(sessionStorage.getItem('cbi.room.draft.int1.q1')).toBeNull();
  });

  it('sends with Ctrl+Enter', async () => {
    const { sockets } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['answer:text'] = () => ({ ok: true });
      },
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Your answer' });
    await user.type(box, 'My answer{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sockets.last.sent('answer:text')).toHaveLength(1));
    expect(sockets.last.sent('answer:text')[0]).toMatchObject({ text: 'My answer' });
  });

  it('replaces the question when the server pushes the next one', async () => {
    const { sockets } = await openRoom();
    const user = userEvent.setup();
    await screen.findByText('Tell me about a project you are proud of.');

    await sockets.last.push('interview:thinking', { sessionId: 'int1' });
    expect(screen.getByText('Preparing the next question…')).toBeInTheDocument();

    await sockets.last.push('round:transition', {
      fromRoundIdx: 0,
      toRoundIdx: 1,
      toRoundType: 'TECHNICAL',
    });
    await sockets.last.push(
      'interview:question',
      makeQuestion({
        questionId: 'q2',
        seq: 2,
        roundIdx: 1,
        roundType: 'TECHNICAL',
        isFollowUp: true,
        text: 'How did you design the database for it?',
      }),
    );

    expect(screen.getByText('How did you design the database for it?')).toBeInTheDocument();
    expect(screen.getByText('Follow-up')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Interview rounds' })).getAllByRole(
      'listitem',
    );
    expect(items[1]).toHaveAttribute('aria-current', 'step');

    // The earlier question moves to the collapsible transcript.
    const toggle = screen.getByRole('button', { name: /Transcript \(1 question\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Tell me about a project you are proud of.')).toBeVisible();
    expect(screen.getByText('No answer')).toBeVisible();
  });

  it('keeps a question pushed before the join acknowledgement and ignores duplicates', async () => {
    let releaseJoin!: (ack: RtAck) => void;
    const q2 = makeQuestion({
      questionId: 'q2',
      seq: 2,
      text: 'Which database did you choose, and why?',
    });
    const { sockets } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['interview:join'] = () => new Promise<RtAck>((r) => (releaseJoin = r));
      },
    });
    await waitFor(() => expect(sockets.last.sent('interview:join')).toHaveLength(1));

    // The server pushes the next question before it acknowledges the join.
    await sockets.last.push('interview:question', q2);
    await act(async () =>
      releaseJoin({
        ok: true,
        snapshot: makeSnapshot({
          currentQuestion: null,
          thinking: true,
          lastSeq: 1,
          turns: [
            {
              seq: 1,
              questionId: 'q1',
              roundIdx: 0,
              question: 'Tell me about a project you are proud of.',
              answer: 'A timetable app.',
              answerSource: 'TEXT',
            },
          ],
        }),
      }),
    );

    expect(await screen.findByText('Which database did you choose, and why?')).toBeInTheDocument();
    expect(screen.queryByText('Preparing the next question…')).not.toBeInTheDocument();

    // The same question again (for example also sent as an event after a snapshot) changes nothing.
    await sockets.last.push('interview:question', q2);
    await sockets.last.push('interview:question', makeQuestion()); // older seq
    expect(screen.getByText('Which database did you choose, and why?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Transcript \(1 question\)/ })).toBeInTheDocument();
  });

  it('shows a question once when it arrives both as an event and in the snapshot', async () => {
    let releaseJoin!: (ack: RtAck) => void;
    const q2 = makeQuestion({ questionId: 'q2', seq: 2, text: 'Walk me through your API.' });
    const { sockets } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['interview:join'] = () => new Promise<RtAck>((r) => (releaseJoin = r));
      },
    });
    await waitFor(() => expect(sockets.last.sent('interview:join')).toHaveLength(1));
    await sockets.last.push('interview:question', q2);
    await act(async () =>
      releaseJoin({
        ok: true,
        snapshot: makeSnapshot({
          currentQuestion: q2,
          lastSeq: 2,
          turns: [
            {
              seq: 1,
              questionId: 'q1',
              roundIdx: 0,
              question: 'Tell me about a project you are proud of.',
              answer: 'A timetable app.',
              answerSource: 'TEXT',
            },
            {
              seq: 2,
              questionId: 'q2',
              roundIdx: 0,
              question: q2.text,
              answer: null,
              answerSource: null,
            },
          ],
        }),
      }),
    );

    expect(await screen.findAllByText('Walk me through your API.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Transcript \(1 question\)/ })).toBeInTheDocument();
  });

  it('shows the reconnecting overlay, re-joins with lastSeq and resends the unacked answer', async () => {
    let acks = 0;
    const { sockets } = await openRoom({
      setup: (socket) => {
        // The first attempt is lost with the connection; later ones succeed.
        socket.ackHandlers['answer:text'] = () =>
          acks++ === 0 ? new Promise<RtAck>(() => undefined) : { ok: true };
      },
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Your answer' });
    await user.type(box, 'An answer typed before the network dropped.');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(sockets.last.sent('answer:text')).toHaveLength(1);

    await sockets.last.serverDisconnect();
    expect(
      screen.getByRole('heading', { name: 'Reconnecting… your progress is saved' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Reconnecting…').length).toBeGreaterThan(0);
    expect(box).toHaveValue('An answer typed before the network dropped.');

    await sockets.last.serverConnect();

    await waitFor(() => expect(sockets.last.sent('answer:text')).toHaveLength(2));
    expect(sockets.last.sent('interview:join')).toEqual([
      { sessionId: 'int1', lastSeq: 0 },
      { sessionId: 'int1', lastSeq: 1 },
    ]);
    const [first, second] = sockets.last.sent('answer:text') as [AnswerPayload, AnswerPayload];
    expect(second.clientMsgId).toBe(first.clientMsgId);
    await waitFor(() => expect(box).toHaveValue(''));
    expect(
      screen.queryByRole('heading', { name: 'Reconnecting… your progress is saved' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('re-joins to resync when the question is stale', async () => {
    let joins = 0;
    const { sockets } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['interview:join'] = () =>
          joins++ === 0
            ? { ok: true, snapshot: makeSnapshot() }
            : {
                ok: true,
                snapshot: makeSnapshot({
                  currentQuestion: makeQuestion({
                    questionId: 'q2',
                    seq: 2,
                    text: 'What would you do differently next time?',
                  }),
                }),
              };
        socket.ackHandlers['answer:text'] = () => ({
          ok: false,
          code: 'STALE_QUESTION',
          message: 'stale',
        });
      },
    });
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Your answer' });
    await user.type(box, 'Late answer');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(await screen.findByText('What would you do differently next time?')).toBeInTheDocument();
    expect(sockets.last.sent('interview:join')).toHaveLength(2);
    expect(sockets.last.sent('interview:join')[1]).toEqual({ sessionId: 'int1', lastSeq: 1 });
    expect(screen.getByRole('alert')).toHaveTextContent(/already moved on/);
  });

  it('goes to the complete screen when the interview completes', async () => {
    const { sockets, router } = await openRoom({
      handlers: {
        'GET /interviews/int1': () =>
          ok(makeInterview({ state: 'PROCESSING', credit: 'CONSUMED' })),
      },
    });
    await screen.findByText('Tell me about a project you are proud of.');
    await sockets.last.push(
      'interview:completed',
      makeSnapshot({ state: 'PROCESSING', currentQuestion: null, clockRunning: false }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/complete'),
    );
    expect(
      await screen.findByRole('heading', { name: 'Thank you for completing your interview' }),
    ).toBeInTheDocument();
  });

  it('goes straight to the complete screen when joining an interview that has ended', async () => {
    const { router } = await openRoom({
      snapshot: { state: 'EXPIRED', currentQuestion: null, clockRunning: false },
      handlers: {
        'GET /interviews/int1': () => ok(makeInterview({ state: 'EXPIRED', credit: 'CONSUMED' })),
      },
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/complete'),
    );
  });

  it('ends the interview after an in-page confirmation', async () => {
    const ended = makeInterview({ state: 'PROCESSING', credit: 'REFUNDED' });
    const { api, router } = await openRoom({
      handlers: {
        'POST /interviews/int1/end': () => ok(ended),
        'GET /interviews/int1': () => ok(ended),
      },
    });
    const user = userEvent.setup();
    await screen.findByText('Tell me about a project you are proud of.');

    await user.click(screen.getByRole('button', { name: 'End interview' }));
    expect(screen.getByRole('heading', { name: 'End now?' })).toHaveFocus();
    expect(screen.getByText('Unanswered questions are skipped.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /interviews/int1/end')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByRole('heading', { name: 'End now?' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'End interview' }));
    await user.click(screen.getByRole('button', { name: 'Yes, end the interview' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/complete'),
    );
    expect(api.calls.filter((c) => c.key === 'POST /interviews/int1/end')).toHaveLength(1);
    expect(
      await screen.findByText('Your credit was returned because the interview ended early.'),
    ).toBeInTheDocument();
  });

  it('sends the candidate to the start screen when the interview has not started', async () => {
    const { router } = await openRoom({
      setup: (socket) => {
        socket.ackHandlers['interview:join'] = () => ({
          ok: false,
          code: 'INVALID_STATE',
          message: 'not started',
        });
      },
      handlers: { 'GET /interviews/int1': () => ok(makeInterview()) },
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/app/interviews/int1/start'));
  });
});

describe('interview timer', () => {
  beforeEach(() => {
    // Only the clock and intervals are faked, so promises and React keep running normally.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });

  it('counts down while the clock runs and announces the last five minutes', async () => {
    await openRoom({ snapshot: { remainingMs: 302_000 } });
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveTextContent('05:02');
    // The countdown starts once the room is connected; advancing earlier would tick nothing.
    await waitFor(() => expect(screen.queryByText('(paused)')).not.toBeInTheDocument());

    act(() => vi.advanceTimersByTime(3_000));
    expect(timer).toHaveTextContent('04:59');
    expect(screen.getByText('5 minutes left')).toBeInTheDocument();
  });

  it('does not count down while the clock is stopped', async () => {
    await openRoom({ snapshot: { remainingMs: 125_000, clockRunning: false } });
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveTextContent('02:05');
    act(() => vi.advanceTimersByTime(5_000));
    expect(timer).toHaveTextContent('02:05');
    expect(screen.getByText('(paused)')).toBeInTheDocument();
  });
});
