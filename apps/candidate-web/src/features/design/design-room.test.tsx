import type { DesignWorkspace } from '@cbi/shared-types';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { fakeSocketFactory, makeQuestion, makeSnapshot } from '../../test/fake-socket';
import { renderRoute } from '../../test/render';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const ROOM = '/app/interviews/int1/room';
const WS = '/interviews/int1/design/d1';

const EMPTY = { requirements: '', api: '', dataModel: '', scaling: '', tradeOffs: '' };

function makeDesign(overrides: Partial<DesignWorkspace> = {}): DesignWorkspace {
  return {
    questionId: 'd1',
    prompt: {
      id: 'p1',
      title: 'Short links for a marketing team',
      prompt: 'Design a service that turns long URLs into short links.\n\nMostly redirects.',
      difficulty: 'EASY',
      focusAreas: ['How codes are generated'],
    },
    notes: EMPTY,
    diagram: { nodes: [], edges: [] },
    autosavedAt: null,
    submittedAt: null,
    ...overrides,
  };
}

const designQuestion = makeQuestion({
  questionId: 'd1',
  seq: 3,
  roundIdx: 1,
  roundType: 'SYSTEM_DESIGN',
  text: 'System design: Short links for a marketing team.',
  design: { promptId: 'p1', title: 'Short links for a marketing team' },
});

async function openDesignRoom(handlers: Parameters<typeof fakeApi>[0] = {}) {
  const sockets = fakeSocketFactory({
    setup: (socket) => {
      socket.ackHandlers['interview:join'] = () => ({
        ok: true,
        snapshot: makeSnapshot({
          currentQuestion: designQuestion,
          roundIdx: 1,
          rounds: [
            { type: 'INTRO', state: 'COMPLETED', durationSec: 300 },
            { type: 'SYSTEM_DESIGN', state: 'ACTIVE', durationSec: 1800 },
          ],
          designQuestionId: 'd1',
        }),
      });
    },
  });
  const api = fakeApi({ ...signedIn, [`GET ${WS}`]: () => ok(makeDesign()), ...handlers });
  const result = await renderRoute(ROOM, { api, socketFactory: sockets.factory });
  await screen.findByRole('heading', { name: 'Short links for a marketing team' });
  return { ...result, sockets };
}

const bodies = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).map((c) => c.body);

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('system design question in the room', () => {
  it('shows the prompt, the whiteboard and the notes instead of the answer box', async () => {
    await openDesignRoom();
    expect(screen.getByText('How codes are generated')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Design whiteboard' })).toBeInTheDocument();
    for (const label of [
      'Requirements',
      'API',
      'Data model',
      'Scaling and reliability',
      'Trade-offs',
    ]) {
      expect(screen.getByRole('textbox', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).not.toBeInTheDocument();
  });

  it('draws boxes and arrows, moves boxes with the keyboard and autosaves the design', async () => {
    const { api } = await openDesignRoom({ [`PUT ${WS}`]: () => ok(makeDesign()) });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Box name'), 'API');
    await user.click(screen.getByRole('button', { name: 'Add box' }));
    await user.type(screen.getByLabelText('Box name'), 'Links DB');
    await user.selectOptions(screen.getByLabelText('Kind'), 'database');
    await user.click(screen.getByRole('button', { name: 'Add box' }));
    // The new box is selected: connect it back to the API.
    await user.selectOptions(screen.getByLabelText('Arrow to'), 'API');
    await user.type(screen.getByLabelText('Arrow label (optional)'), 'reads');
    await user.click(screen.getByRole('button', { name: 'Add arrow' }));
    const box = screen.getByRole('button', { name: 'API (Service)' });
    box.focus();
    await user.keyboard('{ArrowRight}{ArrowDown}');
    const requirements = screen.getByRole('textbox', { name: 'Requirements' });
    await user.type(requirements, '5M links a month');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    // Leaving the notes saves at once (otherwise a few seconds after the last change).
    fireEvent.blur(requirements);
    await waitFor(() => expect(bodies(api, `PUT ${WS}`)).not.toHaveLength(0));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const saved = bodies(api, `PUT ${WS}`).at(-1) as DesignWorkspace;
    expect(saved.notes.requirements).toBe('5M links a month');
    expect(saved.diagram.nodes).toEqual([
      { id: 'n1', label: 'API', kind: 'service', x: 34, y: 34 },
      { id: 'n2', label: 'Links DB', kind: 'database', x: 214, y: 24 },
    ]);
    expect(saved.diagram.edges).toEqual([{ id: 'e1', from: 'n2', to: 'n1', label: 'reads' }]);
    const list = screen.getByText(/Boxes and arrows as a list/).closest('details')!;
    expect(within(list).getByText('Links DB → API: reads')).toBeInTheDocument();
  });

  it('submits the design after a confirmation, then shows it read-only', async () => {
    const { api } = await openDesignRoom({
      [`POST ${WS}/submit`]: () => ok(makeDesign({ submittedAt: '2026-09-20T10:30:00.000Z' })),
    });
    const user = userEvent.setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'API' }), {
      target: { value: 'POST /links' },
    });
    await user.click(screen.getByRole('button', { name: 'Submit design' }));
    expect(
      screen.getByRole('alertdialog', {
        name: "Submit your design? You can't change it afterwards.",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, submit' }));
    expect(
      await screen.findByText('Design submitted. The interviewer will now ask you about it.'),
    ).toBeInTheDocument();
    expect(bodies(api, `POST ${WS}/submit`)).toEqual([
      { notes: { ...EMPTY, api: 'POST /links' }, diagram: { nodes: [], edges: [] } },
    ]);
    expect(screen.getByRole('textbox', { name: 'API' })).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Add box' })).not.toBeInTheDocument();
  });
});
