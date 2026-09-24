import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import {
  JAVA_STARTER,
  makeCodingQuestion,
  makeRunResult,
  makeSubmission,
  makeWorkspace,
  PYTHON_STARTER,
} from '../../test/coding-fixtures';
import { fakeSocketFactory, makeQuestion, makeSnapshot } from '../../test/fake-socket';
import { renderRoute } from '../../test/render';

// Monaco does not run in jsdom: the plain editor stands in for it.
vi.mock('./MonacoCodeEditor', async () => await import('./TextareaCodeEditor'));

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const ROOM = '/app/interviews/int1/room';
const WS = '/interviews/int1/coding/q1';
const EDITOR = 'Code editor (Python 3)';

type Handlers = Parameters<typeof fakeApi>[0];

async function openCodingRoom(
  opts: { handlers?: Handlers; snapshot?: Parameters<typeof makeSnapshot>[0] } = {},
) {
  const question = makeCodingQuestion();
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers['interview:join'] = () => ({
        ok: true,
        snapshot: makeSnapshot({
          currentQuestion: question,
          rounds: [
            { type: 'CODING', state: 'ACTIVE', durationSec: 1200 },
            { type: 'WRAP_UP', state: 'PENDING', durationSec: 300 },
          ],
          ...opts.snapshot,
        }),
      });
    },
  });
  const api = fakeApi({
    ...signedIn,
    [`GET ${WS}`]: () => ok(makeWorkspace()),
    ...opts.handlers,
  });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  const editor = await screen.findByRole('textbox', { name: EDITOR });
  return { ...result, sockets, editor };
}

const bodies = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).map((c) => c.body);

/** Lets fetches and state updates settle while timers are faked. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coding question in the room', () => {
  it('shows the problem, visible tests, hidden count and the starter code, without the answer box', async () => {
    await openCodingRoom();

    expect(screen.getByRole('heading', { level: 2, name: 'Sum of two numbers' })).toBeVisible();
    expect(screen.getByText('Easy')).toBeInTheDocument();
    expect(screen.getByText('Read two integers and print their sum.')).toBeInTheDocument();
    // `inline code` in the statement is shown as code.
    expect(screen.getByText('a', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Example 1')).toBeInTheDocument();
    expect(screen.getByText('1 2')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('+ 3 hidden tests')).toBeInTheDocument();

    expect(screen.getByRole('textbox', { name: EDITOR })).toHaveValue(PYTHON_STARTER);
    const language = screen.getByRole('combobox', { name: 'Programming language' });
    expect(
      within(language)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Python 3', 'Java']);
    // Coding questions are answered in the editor only.
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument();
  });

  it('autosaves 5 seconds after typing stops, and on blur', async () => {
    const { api, editor } = await openCodingRoom({
      handlers: { [`PUT ${WS}`]: () => ok(makeWorkspace()) },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.change(editor, { target: { value: 'print(3)' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(bodies(api, `PUT ${WS}`)).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(bodies(api, `PUT ${WS}`)).toEqual([{ language: 'python', code: 'print(3)' }]);
    await settle();
    expect(screen.getByText('Saved')).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: 'print(1 + 2)' } });
    fireEvent.blur(editor);
    await settle();
    expect(bodies(api, `PUT ${WS}`)).toEqual([
      { language: 'python', code: 'print(3)' },
      { language: 'python', code: 'print(1 + 2)' },
    ]);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('keeps typing and retries quietly when a save fails', async () => {
    let puts = 0;
    const { api, editor } = await openCodingRoom({
      handlers: {
        [`PUT ${WS}`]: () =>
          puts++ === 0 ? fail(503, 'SERVICE_UNAVAILABLE') : ok(makeWorkspace()),
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.change(editor, { target: { value: 'x = 1' } });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await settle();
    expect(screen.getByText('Not saved — retrying')).toBeInTheDocument();
    expect(editor).not.toHaveAttribute('readonly');

    fireEvent.change(editor, { target: { value: 'x = 12' } });
    expect(editor).toHaveValue('x = 12');
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await settle();
    expect(bodies(api, `PUT ${WS}`)).toEqual([
      { language: 'python', code: 'x = 1' },
      { language: 'python', code: 'x = 12' },
    ]);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('loads the other language’s starter code, asking first when the code was edited', async () => {
    const user = userEvent.setup();
    const { editor } = await openCodingRoom({
      handlers: { [`PUT ${WS}`]: () => ok(makeWorkspace()) },
    });
    const language = screen.getByRole('combobox', { name: 'Programming language' });

    await user.selectOptions(language, 'java');
    const javaEditor = screen.getByRole('textbox', { name: 'Code editor (Java)' });
    expect(javaEditor).toHaveValue(JAVA_STARTER);

    await user.selectOptions(language, 'python');
    expect(editor).toHaveValue(PYTHON_STARTER);
    fireEvent.change(editor, { target: { value: 'print(42)' } });

    await user.selectOptions(language, 'java');
    expect(screen.getByRole('heading', { name: 'Switch to Java?' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Keep my code' }));
    expect(editor).toHaveValue('print(42)');

    await user.selectOptions(language, 'java');
    await user.click(screen.getByRole('button', { name: 'Switch and replace my code' }));
    expect(screen.getByRole('textbox', { name: 'Code editor (Java)' })).toHaveValue(JAVA_STARTER);
  });

  it('runs the code and shows each visible test’s verdict (also with Ctrl+Enter)', async () => {
    const user = userEvent.setup();
    const { api, editor } = await openCodingRoom({
      handlers: { [`POST ${WS}/run`]: () => ok(makeWorkspace({ lastRun: makeRunResult() })) },
    });
    fireEvent.change(editor, { target: { value: 'print(sum(map(int, input().split())))' } });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(bodies(api, `POST ${WS}/run`)).toEqual([
      { language: 'python', code: 'print(sum(map(int, input().split())))' },
    ]);
    const results = screen.getByRole('region', { name: 'Results' });
    expect(await within(results).findAllByText('1 of 2 example tests passed')).toHaveLength(2);
    const rows = within(results).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Test 1');
    expect(rows[0]).toHaveTextContent('Passed');
    expect(rows[1]).toHaveTextContent('Wrong answer');
    expect(within(rows[1]!).getByText('9')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Your output')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Expected output')).toBeInTheDocument();

    editor.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bodies(api, `POST ${WS}/run`)).toHaveLength(2));
  });

  it('shows a non-blocking notice when the code cannot be run, keeping the code', async () => {
    const user = userEvent.setup();
    const { editor } = await openCodingRoom({
      handlers: { [`POST ${WS}/run`]: () => fail(503, 'JUDGE_UNAVAILABLE') },
    });
    fireEvent.change(editor, { target: { value: 'print(3)' } });
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(
      await screen.findByText(
        'Running code is temporarily unavailable — keep working; you can still submit.',
      ),
    ).toBeInTheDocument();
    expect(editor).toHaveValue('print(3)');
    expect(editor).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
    // The server saved the code with the run attempt.
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('submits after confirmation, shows the result and moves on when the next question arrives', async () => {
    const user = userEvent.setup();
    const { api, sockets, editor } = await openCodingRoom({
      handlers: {
        [`POST ${WS}/submit`]: () =>
          ok(makeWorkspace({ code: 'print(3)', submission: makeSubmission() })),
      },
    });
    fireEvent.change(editor, { target: { value: 'print(3)' } });

    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(
      screen.getByRole('heading', {
        name: "Submit your solution? You can't change it afterwards.",
      }),
    ).toHaveFocus();
    expect(bodies(api, `POST ${WS}/submit`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Yes, submit' }));

    expect(
      await screen.findAllByText('Submitted. 4 of 5 tests passed, including hidden tests.'),
    ).not.toHaveLength(0);
    expect(bodies(api, `POST ${WS}/submit`)).toEqual([{ language: 'python', code: 'print(3)' }]);
    expect(screen.getByText('Hidden test 3')).toBeInTheDocument();
    expect(screen.getByText('Time limit exceeded')).toBeInTheDocument();
    expect(editor).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    // Never sent as a typed answer.
    expect(sockets.last.sent('answer:text')).toHaveLength(0);

    // The result stays while the interviewer prepares the next question.
    await sockets.last.push('interview:thinking', { sessionId: 'int1' });
    expect(screen.getByText('Preparing the next question…')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: EDITOR })).toBeInTheDocument();

    await sockets.last.push(
      'interview:question',
      makeQuestion({ questionId: 'q2', seq: 2, text: 'How would you test it?' }),
    );
    expect(screen.getByText('How would you test it?')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: EDITOR })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Transcript \(1 question\)/ }));
    expect(screen.getByText('Sum of two numbers')).toBeVisible();
    expect(screen.getByText('Solution submitted (4/5 tests passed)')).toBeVisible();
    expect(screen.queryByText('print(3)')).not.toBeInTheDocument();
  });

  it('confirms a submission the judge could not run', async () => {
    const user = userEvent.setup();
    await openCodingRoom({
      handlers: {
        [`POST ${WS}/submit`]: () =>
          ok(
            makeWorkspace({
              submission: makeSubmission({ result: null, judgeUnavailable: true }),
            }),
          ),
      },
    });
    const editor = screen.getByRole('textbox', { name: EDITOR });
    editor.focus();
    // Ctrl+Shift+Enter opens the confirmation.
    await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
    await user.click(screen.getByRole('button', { name: 'Yes, submit' }));
    expect(
      await screen.findAllByText(
        'Submitted. The code could not be run right now; it will be reviewed from the code.',
      ),
    ).not.toHaveLength(0);
  });

  it('reminds the candidate to submit when little time is left', async () => {
    await openCodingRoom({ snapshot: { remainingMs: 90_000 } });
    expect(screen.getByText('Remember to submit your solution')).toBeInTheDocument();
  });

  it('shows the editor instead of the microphone in a voice interview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await openCodingRoom({ snapshot: { mode: 'VOICE', voiceEnabled: true } });

    expect(screen.getByText('Please solve this coding problem.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start answering' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Type instead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).not.toBeInTheDocument();
  });
});
