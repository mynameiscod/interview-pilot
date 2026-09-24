import type {
  AdminInterviewDetail,
  AdminMeResponse,
  AdminRole,
  Permission,
} from '@cbi/shared-types';
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
import {
  campaign,
  CAMPAIGN_ID,
  interviewDetail,
  interviewRow,
  scoreRevision,
} from '../campaigns/test-fixtures';

const REASON = 'Reason (recorded in the audit log)';
const REVISE_REASON = 'Reason for this revision (recorded in the audit log)';

function adminMe(roles: AdminRole[]): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

async function renderAt(
  path: string,
  roles: AdminRole[],
  handlers: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles)),
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

const interviewQueries = (api: ReturnType<typeof fakeApi>) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith('/admin/interviews'))
    .map((u) => Object.fromEntries(u.searchParams));

describe('interviews list', () => {
  it('lists interviews and filters by state, campaign, flag and search', async () => {
    const { api, router } = await renderAt('/interviews', ['SUPPORT_ADMIN'], {
      'GET /admin/campaigns': () => ok([campaign()]),
      'GET /admin/interviews': () =>
        ok([
          interviewRow(),
          interviewRow({
            id: 'int2',
            state: 'PROCESSING',
            campaign: null,
            overall: null,
            band: null,
            candidate: { userId: 'user-9', email: null },
            flag: { flagged: true, reason: 'Odd answers', by: 'admin-1', at: null },
          }),
        ]),
    });
    const table = await screen.findByRole('table');
    const first = within(table).getByRole('row', { name: /int1/ });
    expect(within(first).getByText('asha@example.com')).toBeInTheDocument();
    expect(within(first).getByText('Report ready')).toBeInTheDocument();
    expect(within(first).getByText('Ready with gaps')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Globex backend hiring' })).toBeInTheDocument();
    const second = within(table).getByRole('row', { name: /int2/ });
    expect(within(second).getByText('user-9')).toBeInTheDocument();
    expect(within(second).getByText('Flagged')).toBeInTheDocument();
    expect(interviewQueries(api)[0]).toEqual({ limit: '100' });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('State'), 'REPORT_READY');
    const campaignSelect = screen.getByLabelText('Campaign');
    await within(campaignSelect).findByRole('option', { name: 'Globex backend hiring' });
    await user.selectOptions(campaignSelect, CAMPAIGN_ID);
    await user.selectOptions(screen.getByLabelText('Flag'), 'true');
    await user.type(screen.getByLabelText('Search'), ' asha@example.com ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const expected = {
      limit: '100',
      state: 'REPORT_READY',
      campaignId: CAMPAIGN_ID,
      flagged: 'true',
      q: 'asha@example.com',
    };
    await expect.poll(() => interviewQueries(api).at(-1)).toEqual(expected);
    expect(router.state.location.search).toBe(
      `?state=REPORT_READY&campaignId=${CAMPAIGN_ID}&flagged=true&q=asha%40example.com`,
    );

    await user.click(screen.getByRole('link', { name: 'Open interview int1' }));
    await expect.poll(() => router.state.location.pathname).toBe('/interviews/int1');
  });

  it('is hidden from admins without interviews.read', async () => {
    await renderAt('/interviews', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });
});

describe('interview review', () => {
  it('shows the transcript, evidence and revisions read-only to support admins', async () => {
    await renderAt('/interviews/int1', ['SUPPORT_ADMIN'], {
      'GET /admin/interviews/int1': () => ok(interviewDetail()),
    });
    expect(await screen.findByText('How would you version a public API?')).toBeInTheDocument();
    expect(screen.getByText('Explains versioning trade-offs')).toBeInTheDocument();
    expect(screen.getByText('Revision 0 (AI original, never modified)')).toBeInTheDocument();
    expect(screen.getByText('$0.04')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flag for review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revise scores' })).not.toBeInTheDocument();
  });

  it('flags an interview with a reason', async () => {
    const { api } = await renderAt('/interviews/int1', ['OPERATIONS_ADMIN'], {
      'GET /admin/interviews/int1': () => ok(interviewDetail()),
      'POST /admin/interviews/int1/flag': () =>
        ok(
          interviewRow({
            flag: { flagged: true, reason: 'Answers look copied', by: 'admin-1', at: null },
          }),
        ),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Flag for review' }));
    await user.type(screen.getByLabelText(REASON), 'Answers look copied');
    await user.click(screen.getByRole('button', { name: 'Flag interview' }));
    expect(await screen.findByText('The interview is flagged for review.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/interviews/int1/flag')).toEqual({
      flagged: true,
      reason: 'Answers look copied',
    });
    expect(screen.getByText('Reason: Answers look copied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove flag' })).toBeInTheDocument();
  });

  it('validates and submits a score revision, then shows the new revision', async () => {
    let detail: AdminInterviewDetail = interviewDetail();
    const { api } = await renderAt('/interviews/int1', ['OPERATIONS_ADMIN'], {
      'GET /admin/interviews/int1': () => ok(detail),
      'POST /admin/interviews/int1/revise-score': () => {
        const revised = scoreRevision({
          revision: 1,
          overall: 83,
          dimensions: [
            {
              key: 'api-design',
              name: 'API design',
              weight: 60,
              score: 90,
              note: 'Clear versioning answer',
            },
            { key: 'debugging', name: 'Debugging', weight: 40, score: 71, note: null },
          ],
          createdBy: 'admin-1',
          reason: 'Calibration review',
        });
        detail = interviewDetail({
          overall: 83,
          scoreRevision: 1,
          scoreRevisions: [scoreRevision(), revised],
        });
        return { status: 201, body: { data: revised } };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revise scores' }));
    const submit = screen.getByRole('button', { name: 'Save revision' });

    await user.click(submit);
    expect(await screen.findByText('Change at least one score.')).toBeInTheDocument();

    const score = screen.getByLabelText('New score for API design');
    const note = screen.getByLabelText('Note for API design');
    expect(score).toHaveValue('82');
    expect(note).toBeDisabled();
    await user.clear(score);
    await user.type(score, '190');
    await user.click(submit);
    expect(
      await screen.findByText('Enter a whole number from 0 to 100, or leave it empty.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Explain this change in 3–500 characters.')).toBeInTheDocument();
    expect(screen.getByText('Enter a reason of 3–500 characters.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/interviews/int1/revise-score')).toBe(false);

    await user.clear(score);
    await user.type(score, '90');
    await user.type(note, 'Clear versioning answer');
    await user.type(screen.getByLabelText(REVISE_REASON), 'Calibration review');
    await user.click(submit);
    expect(
      await screen.findByText('Revision 1 saved. A new report was generated from it.'),
    ).toBeInTheDocument();
    // Only the changed dimension is sent.
    expect(bodyOf(api, 'POST /admin/interviews/int1/revise-score')).toEqual({
      dimensions: [{ key: 'api-design', score: 90, note: 'Clear versioning answer' }],
      reason: 'Calibration review',
    });
    expect(await screen.findByText('Reason: Calibration review')).toBeInTheDocument();
    expect(screen.getByText('Revision 0 (AI original, never modified)')).toBeInTheDocument();
    expect(screen.getByText('Clear versioning answer')).toBeInTheDocument();
  });

  it('shows why scores cannot be revised before the report is ready', async () => {
    await renderAt('/interviews/int1', ['OPERATIONS_ADMIN'], {
      'GET /admin/interviews/int1': () =>
        ok(interviewDetail({ state: 'PROCESSING', scoreRevisions: [], reportRevisions: [] })),
    });
    expect(await screen.findByRole('button', { name: 'Revise scores' })).toBeDisabled();
    expect(screen.getByText('Scores can be revised once the report is ready.')).toBeInTheDocument();
    // Operations admins can still re-run a stuck evaluation.
    expect(screen.getByRole('button', { name: 'Re-run evaluation' })).toBeInTheDocument();
  });

  it('shows the server message when the interview has no report yet', async () => {
    await renderAt('/interviews/int1', ['OPERATIONS_ADMIN'], {
      'GET /admin/interviews/int1': () => ok(interviewDetail()),
      'POST /admin/interviews/int1/revise-score': () => ({
        status: 409,
        body: {
          error: {
            code: 'INVALID_STATE',
            message: 'Only interviews with a report can be reviewed.',
            requestId: 'r1',
          },
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revise scores' }));
    const score = screen.getByLabelText('New score for Debugging');
    await user.clear(score);
    await user.type(score, '60');
    await user.type(screen.getByLabelText('Note for Debugging'), 'Missed the root cause');
    await user.type(screen.getByLabelText(REVISE_REASON), 'Second look');
    await user.click(screen.getByRole('button', { name: 'Save revision' }));
    expect(
      await screen.findByText('Only interviews with a report can be reviewed.'),
    ).toBeInTheDocument();
  });

  it('reports a missing interview', async () => {
    await renderAt('/interviews/nope', ['SUPPORT_ADMIN'], {
      'GET /admin/interviews/nope': () => fail(404, 'NOT_FOUND'),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
