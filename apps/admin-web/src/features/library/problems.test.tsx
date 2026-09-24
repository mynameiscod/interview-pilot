import type { AdminMeResponse, AdminRole, Permission } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { problem } from './test-fixtures';

const REASON = 'Reason (recorded in the audit log)';

function adminMe(access: AdminRole[] | Permission[]): AdminMeResponse {
  const roles = access.filter((a): a is AdminRole => !a.includes('.'));
  const permissions = roles.length > 0 ? [...permissionsFor(roles)] : (access as Permission[]);
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions,
  };
}

async function renderAt(
  path: string,
  access: AdminRole[] | Permission[],
  handlers: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(access)),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider manager={manager} loadUser={loadAdminUser}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api, router };
}

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.find((c) => c.key === key)!.body;
const posted = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.some((c) => c.key === key);

const problems = () => [
  problem(),
  problem({
    id: 'prob-two-sum-1',
    version: 1,
    active: false,
    title: 'Two sum (first draft)',
    hiddenTests: [{ input: '2\n1 1\n2\n', expectedOutput: '0 1\n', explanation: null }],
  }),
  problem({
    id: 'prob-fizz-1',
    key: 'fizz-buzz',
    version: 1,
    active: false,
    title: 'Fizz buzz',
    difficulty: 'MEDIUM',
    tags: [],
  }),
];

const listHandlers = (extra: Parameters<typeof fakeApi>[0] = {}) => ({
  'GET /admin/problems': () => ok(problems()),
  ...extra,
});

describe('coding problems navigation', () => {
  it('lists Coding problems under Library for content admins', async () => {
    await renderAt('/', ['CONTENT_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const library = within(nav).getByRole('list', { name: 'Library' });
    expect(within(library).getByRole('link', { name: 'Coding problems' })).toHaveAttribute(
      'href',
      '/problems',
    );
  });

  it('blocks support admins, who have no library access', async () => {
    const { api } = await renderAt('/problems', ['SUPPORT_ADMIN'], listHandlers());
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'Coding problems' })).not.toBeInTheDocument();
    expect(posted(api, 'GET /admin/problems')).toBe(false);
  });
});

describe('coding problems', () => {
  it('groups versions by key and highlights the active one', async () => {
    await renderAt('/problems', ['CONTENT_ADMIN'], listHandlers());
    const twoSum = await screen.findByRole('region', { name: 'two-sum' });
    expect(
      within(twoSum).getByText(
        'Python 3, JavaScript (Node.js) · 1 visible · 2 hidden · 2000 ms CPU · 256 MB memory',
      ),
    ).toBeInTheDocument();
    const tags = within(twoSum).getByRole('list', { name: 'Tags' });
    expect(within(tags).getByText('arrays')).toBeInTheDocument();
    expect(within(tags).getByText('hashing')).toBeInTheDocument();

    const v2 = within(twoSum).getByRole('row', { name: /^v2/ });
    expect(v2).toHaveClass('table-success');
    expect(within(v2).getByText('Active')).toBeInTheDocument();
    expect(within(v2).getByText('Easy')).toBeInTheDocument();
    const v1 = within(twoSum).getByRole('row', { name: /^v1/ });
    expect(v1).not.toHaveClass('table-success');
    expect(within(v1).getByText('Two sum (first draft)')).toBeInTheDocument();
    expect(within(v1).getByText('Inactive')).toBeInTheDocument();
    expect(within(v1).getByText('1 visible · 1 hidden')).toBeInTheDocument();
    // Newest version first.
    const rows = within(twoSum).getAllByRole('row').slice(1);
    expect(rows[0]).toBe(v2);

    const fizz = screen.getByRole('region', { name: 'fizz-buzz' });
    expect(
      within(fizz).getByText('No active version: new interviews do not get this problem.'),
    ).toBeInTheDocument();
    expect(within(fizz).getByText('Medium')).toBeInTheDocument();
  });

  it('shows the statement, starter code and tests, with hidden tests labelled', async () => {
    await renderAt('/problems', ['CONTENT_ADMIN'], listHandlers());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View two-sum v2' }));
    const viewer = screen.getByRole('article', { name: 'Problem two-sum v2' });

    const statement = within(viewer).getByRole('region', { name: 'Statement' });
    expect(within(statement).getAllByRole('paragraph')).toHaveLength(2);
    expect(within(statement).getByText('n').tagName).toBe('CODE');

    expect(within(viewer).getByLabelText('Starter code for Python 3').textContent).toBe(
      'import sys\n\ndef solve():\n    pass\n',
    );
    expect(
      within(viewer).getByLabelText('Starter code for JavaScript (Node.js)'),
    ).toBeInTheDocument();

    const visible = within(viewer).getByRole('region', { name: 'Visible tests' });
    expect(within(visible).getByLabelText('Visible test 1 input').textContent).toBe(
      '4\n2 7 11 15\n9\n',
    );
    expect(within(visible).getByText('2 + 7 = 9')).toBeInTheDocument();

    const hidden = within(viewer).getByRole('region', { name: 'Hidden tests' });
    expect(within(hidden).getByText('Hidden — never shown to candidates')).toBeInTheDocument();
    expect(within(hidden).getByLabelText('Hidden test 1 input').textContent).toBe('3\n3 2 4\n6\n');
    expect(within(hidden).getByLabelText('Hidden test 2 expected output').textContent).toBe(
      '0 1\n',
    );
  });

  it('creates a new version prefilled from a version and posts the exact body', async () => {
    const { api } = await renderAt(
      '/problems',
      ['CONTENT_ADMIN'],
      listHandlers({
        'POST /admin/problems': () => ({
          status: 201,
          body: { data: problem({ id: 'prob-two-sum-3', version: 3, active: false }) },
        }),
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New version from two-sum v2' }));
    expect(
      screen.getByRole('heading', { name: 'New version of two-sum from v2' }),
    ).toBeInTheDocument();
    // The key is fixed for a new version.
    expect(screen.queryByLabelText('Problem key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Two sum');
    const form = screen.getByRole('form', { name: 'New version of two-sum from v2' });
    expect(within(form).getByLabelText('Tags')).toHaveValue('arrays, hashing');
    expect(screen.getByLabelText('Python 3')).toBeChecked();
    expect(screen.getByLabelText('Java')).not.toBeChecked();
    expect(screen.getByLabelText('Hidden test 1 input')).toHaveValue('3\n3 2 4\n6\n');
    expect(screen.getByLabelText('Hidden test 1 expected output')).toHaveValue('1 2\n');
    expect(screen.getByLabelText('Visible test 1 explanation')).toHaveValue('2 + 7 = 9');

    // Drop JavaScript: its starter code is no longer sent.
    await user.click(screen.getByLabelText('JavaScript (Node.js)'));
    expect(
      screen.queryByLabelText('Starter code for JavaScript (Node.js)'),
    ).not.toBeInTheDocument();

    // Outputs are compared exactly: spaces and newlines are kept as typed.
    await user.click(screen.getByRole('button', { name: 'Add hidden test' }));
    await user.type(screen.getByLabelText('Hidden test 3 input'), '1{Enter}  5{Enter}');
    await user.type(screen.getByLabelText('Hidden test 3 expected output'), ' 0 0 {Enter}{Enter}');
    await user.clear(screen.getByLabelText('Memory (MB)'));
    await user.type(screen.getByLabelText('Memory (MB)'), '512');
    await user.type(screen.getByLabelText(REASON), 'Add an edge case');
    await user.click(screen.getByRole('button', { name: 'Create version' }));

    expect(
      await screen.findByText(
        'Created two-sum v3 (inactive). Activate it so new interviews get it.',
      ),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/problems')).toEqual({
      key: 'two-sum',
      content: {
        title: 'Two sum',
        statement:
          'Given `n` numbers and a target, print the indices of the two numbers that add up to the target.\n\nPrint them in increasing order.',
        difficulty: 'EASY',
        tags: ['arrays', 'hashing'],
        languages: ['python'],
        starterCode: { python: 'import sys\n\ndef solve():\n    pass\n' },
        visibleTests: [
          { input: '4\n2 7 11 15\n9\n', expectedOutput: '0 1\n', explanation: '2 + 7 = 9' },
        ],
        hiddenTests: [
          { input: '3\n3 2 4\n6\n', expectedOutput: '1 2\n', explanation: null },
          { input: '2\n3 3\n6\n', expectedOutput: '0 1\n', explanation: null },
          { input: '1\n  5\n', expectedOutput: ' 0 0 \n\n', explanation: null },
        ],
        limits: { cpuMs: 2000, memoryMb: 512 },
      },
      reason: 'Add an edge case',
    });
  });

  it('blocks saving with no hidden tests', async () => {
    const { api } = await renderAt('/problems', ['CONTENT_ADMIN'], listHandlers());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New version from two-sum v2' }));
    await user.click(screen.getByRole('button', { name: 'Remove Hidden test 2' }));
    await user.click(screen.getByRole('button', { name: 'Remove Hidden test 1' }));
    expect(screen.queryByLabelText('Hidden test 1 input')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Remove tests');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(
      await screen.findByText(
        'Add 1–30 hidden tests; input and expected output up to 20,000 characters each.',
      ),
    ).toBeInTheDocument();
    expect(posted(api, 'POST /admin/problems')).toBe(false);
  });

  it('validates a new problem per field and shows server validation issues', async () => {
    const { api } = await renderAt(
      '/problems',
      ['SUPER_ADMIN'],
      listHandlers({
        'POST /admin/problems': () =>
          fail(400, 'VALIDATION_FAILED', {
            issues: [{ path: 'key', message: 'A problem with this key already exists' }],
          }),
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New problem' }));
    await user.type(screen.getByLabelText('Problem key'), 'Two Sum');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(screen.getByLabelText('Problem key')).toHaveAccessibleDescription(
      expect.stringContaining('Use 3–60 lower-case letters, digits and -.'),
    );
    expect(screen.getByLabelText('Title')).toHaveAccessibleDescription(
      'Enter a title of 3–120 characters.',
    );
    expect(screen.getByLabelText('Statement')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(REASON)).toHaveAttribute('aria-invalid', 'true');
    expect(posted(api, 'POST /admin/problems')).toBe(false);

    await user.clear(screen.getByLabelText('Problem key'));
    await user.type(screen.getByLabelText('Problem key'), 'two-sum');
    await user.type(screen.getByLabelText('Title'), 'Two sum');
    await user.type(
      screen.getByLabelText('Statement'),
      'Print the indices of the two numbers that add up to the target.',
    );
    await user.type(screen.getByLabelText('Visible test 1 input'), '2{Enter}1 1{Enter}2');
    await user.type(screen.getByLabelText('Visible test 1 expected output'), '0 1');
    await user.type(screen.getByLabelText('Hidden test 1 input'), '2{Enter}3 3{Enter}6');
    await user.type(screen.getByLabelText('Hidden test 1 expected output'), '0 1');
    await user.type(screen.getByLabelText(REASON), 'New problem');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(await screen.findByText('A problem with this key already exists')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/problems')).toMatchObject({
      key: 'two-sum',
      content: {
        languages: ['python'],
        starterCode: { python: '' },
        visibleTests: [{ input: '2\n1 1\n2', expectedOutput: '0 1', explanation: null }],
        hiddenTests: [{ input: '2\n3 3\n6', expectedOutput: '0 1', explanation: null }],
        limits: { cpuMs: 2000, memoryMb: 256 },
      },
    });
  });

  it('activates a version only with a reason and explains the effect', async () => {
    const { api } = await renderAt(
      '/problems',
      ['CONTENT_ADMIN'],
      listHandlers({
        'POST /admin/problems/prob-two-sum-1/activate': () =>
          ok(problem({ id: 'prob-two-sum-1', version: 1 })),
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate two-sum v1' }));
    expect(
      screen.getByText(
        'New interviews will get v1 of two-sum, replacing the version that is active now.',
      ),
    ).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Activate two-sum v1' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'ok');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), ' now');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(
      await screen.findByText('two-sum v1 is now active. New interviews get this version.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/problems/prob-two-sum-1/activate')).toEqual({
      reason: 'ok now',
    });
  });

  it('deactivates the active version with a reason', async () => {
    const { api } = await renderAt(
      '/problems',
      ['CONTENT_ADMIN'],
      listHandlers({
        'POST /admin/problems/prob-two-sum-2/deactivate': () => ok(problem({ active: false })),
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate two-sum v2' }));
    expect(
      screen.getByText('New interviews will not get two-sum until another version is activated.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Leaked online');
    await user.click(screen.getByRole('button', { name: 'Deactivate two-sum v2' }));
    expect(await screen.findByText('two-sum v2 was deactivated.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/problems/prob-two-sum-2/deactivate')).toEqual({
      reason: 'Leaked online',
    });
  });

  it('shows management controls only with library.manage', async () => {
    await renderAt('/problems', ['library.read'], listHandlers());
    expect(await screen.findByRole('region', { name: 'two-sum' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View two-sum v2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New problem' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New version from two-sum v2' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate two-sum v1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate two-sum v2' })).not.toBeInTheDocument();
  });

  it('lets content admins manage problems', async () => {
    await renderAt('/problems', ['CONTENT_ADMIN'], listHandlers());
    expect(
      await screen.findByRole('button', { name: 'New version from two-sum v1' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New problem' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate two-sum v1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate two-sum v2' })).toBeInTheDocument();
  });
});
