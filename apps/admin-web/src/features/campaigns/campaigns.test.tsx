import type { AdminMeResponse, AdminRole, Permission } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';
import { company, role, template } from '../library/test-fixtures';
import { campaign, CAMPAIGN_ID, resultRow, results } from './test-fixtures';

const REASON = 'Reason (recorded in the audit log)';

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

/** fakeApi keys ignore the query string, so filtered requests are checked by URL. */
const resultQueries = (api: ReturnType<typeof fakeApi>) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith('/results'))
    .map((u) => Object.fromEntries(u.searchParams));

const DETAIL = `/campaigns/${CAMPAIGN_ID}`;
const detailHandlers = (overrides: Parameters<typeof campaign>[0] = {}) => ({
  [`GET /admin/campaigns/${CAMPAIGN_ID}`]: () => ok(campaign(overrides)),
  [`GET /admin/campaigns/${CAMPAIGN_ID}/results`]: () => ok(results()),
});

describe('campaigns navigation', () => {
  it('shows campaigns and interviews to support admins under one group', async () => {
    await renderAt('/', ['SUPPORT_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const group = within(nav).getByRole('list', { name: 'Campaigns & review' });
    expect(within(group).getByRole('link', { name: 'Campaigns' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Interviews' })).toBeInTheDocument();
  });

  it('hides campaigns from admins without campaigns.read', async () => {
    await renderAt('/campaigns', ['CONTENT_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'Campaigns' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Interviews' })).not.toBeInTheDocument();
  });

  it('lets support admins read campaigns without managing them', async () => {
    await renderAt('/campaigns', ['SUPPORT_ADMIN'], {
      'GET /admin/campaigns': () => ok([campaign()]),
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /Globex backend hiring/ });
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(within(row).getByText('12 of 50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New campaign' })).not.toBeInTheDocument();
  });

  it('shows campaign details without actions or exports to support admins', async () => {
    await renderAt(DETAIL, ['SUPPORT_ADMIN'], detailHandlers());
    expect(await screen.findByText('9 of 40 used')).toBeInTheDocument();
    expect(screen.getByText('Starts with k3Xq…')).toBeInTheDocument();
    expect(screen.getByText('12 of 50')).toBeInTheDocument();
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate invite link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
    // Support admins may read interviews, so the review link is shown.
    expect(screen.getByRole('link', { name: 'Review the interview of Asha Rao' })).toHaveAttribute(
      'href',
      '/interviews/int1',
    );
  });
});

describe('creating a campaign', () => {
  it('validates, creates a draft and shows the invite link once with copy', async () => {
    const { api } = await renderAt('/campaigns', ['OPERATIONS_ADMIN'], {
      'GET /admin/campaigns': () => ok([]),
      'GET /admin/roles': () =>
        ok([role(), role({ id: 'r2', title: 'No blueprint', activeBlueprintId: null })]),
      'GET /admin/templates': () =>
        ok([template(), template({ id: 't0', key: 'retired-type', status: 'RETIRED' })]),
      'GET /admin/companies': () => ok([company()]),
      'POST /admin/campaigns': () => ({
        status: 201,
        body: { data: { campaign: campaign(), invitePath: '/campaign/tok-secret-123' } },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New campaign' }));
    const roleSelect = await screen.findByLabelText('Role');
    expect(within(roleSelect).queryByRole('option', { name: 'No blueprint' })).toBeNull();
    const typeSelect = screen.getByLabelText('Interview type');
    expect(within(typeSelect).queryByRole('option', { name: /retired-type/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create draft campaign' }));
    expect(await screen.findByText('Enter a name of 3–120 characters.')).toBeInTheDocument();
    expect(screen.getByText('Choose a role.')).toBeInTheDocument();
    expect(screen.getByText('Choose an interview type.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/campaigns')).toBe(false);

    await user.type(screen.getByLabelText('Campaign name'), 'Globex backend hiring');
    // Choosing a library company fills in the name candidates see.
    await user.selectOptions(screen.getByLabelText('Library company'), 'c1');
    expect(screen.getByLabelText('Company name')).toHaveValue('Globex');
    await user.selectOptions(roleSelect, 'r1');
    await user.selectOptions(typeSelect, 'standard-technical');
    // The template offers text only.
    expect(screen.getByLabelText('Voice')).toBeDisabled();
    await user.click(screen.getByLabelText('Hindi'));
    await user.type(screen.getByLabelText('Candidate limit'), '50');
    await user.click(screen.getByRole('button', { name: 'Create draft campaign' }));

    const panel = await screen.findByRole('region', {
      name: 'Invite link for Globex backend hiring',
    });
    const body = bodyOf(api, 'POST /admin/campaigns') as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Globex backend hiring',
      companyId: 'c1',
      companyName: 'Globex',
      roleId: 'r1',
      templateKey: 'standard-technical',
      jobDescription: null,
      modes: ['TEXT'],
      languages: ['auto', 'hi'],
      window: { endAt: null },
      maxCandidates: 50,
      proctoring: { recording: 'OFF', tabSwitchTracking: false },
      candidateSeesReport: true,
      sponsoredCredits: null,
    });
    expect(typeof (body.window as { startAt: unknown }).startAt).toBe('string');

    expect(
      within(panel).getByText(/Copy this link now\. It will not be shown again/),
    ).toBeInTheDocument();
    const link = within(panel).getByRole('textbox') as HTMLInputElement;
    expect(link.value).toMatch(/\/campaign\/tok-secret-123$/);
    await user.click(within(panel).getByRole('button', { name: 'Copy link' }));
    expect(await within(panel).findByText('Copied to the clipboard.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(link.value);
    expect(within(panel).getByRole('link', { name: 'Open campaign' })).toHaveAttribute(
      'href',
      DETAIL,
    );

    await user.click(within(panel).getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByDisplayValue(/tok-secret-123/)).not.toBeInTheDocument();
  });
});

describe('campaign status and invite link', () => {
  it('activates a draft with a reason', async () => {
    const { api } = await renderAt(DETAIL, ['OPERATIONS_ADMIN'], {
      ...detailHandlers(),
      [`POST /admin/campaigns/${CAMPAIGN_ID}/status`]: () => ok(campaign({ status: 'ACTIVE' })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate' }));
    expect(
      screen.getByText('Candidates with the invite link can join while the campaign is open.'),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Activate' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Hiring round opens');
    await user.click(submit);
    expect(await screen.findByText('The campaign is now Active.')).toBeInTheDocument();
    expect(bodyOf(api, `POST /admin/campaigns/${CAMPAIGN_ID}/status`)).toEqual({
      status: 'ACTIVE',
      reason: 'Hiring round opens',
    });
    // Active campaigns can be paused or closed.
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close campaign' })).toBeInTheDocument();
  });

  it('asks for confirmation before closing for good', async () => {
    const { api } = await renderAt(DETAIL, ['OPERATIONS_ADMIN'], {
      ...detailHandlers({ status: 'PAUSED' }),
      [`POST /admin/campaigns/${CAMPAIGN_ID}/status`]: () => ok(campaign({ status: 'CLOSED' })),
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close campaign' }));
    const submit = screen.getByRole('button', { name: 'Close permanently' });
    await user.type(screen.getByLabelText(REASON), 'Position filled');
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByLabelText('I understand that closing is final and cannot be undone.'),
    );
    await user.click(submit);
    expect(await screen.findByText('The campaign is now Closed.')).toBeInTheDocument();
    expect(bodyOf(api, `POST /admin/campaigns/${CAMPAIGN_ID}/status`)).toEqual({
      status: 'CLOSED',
      reason: 'Position filled',
    });
    expect(screen.queryByRole('button', { name: 'Rotate invite link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit settings' })).not.toBeInTheDocument();
  });

  it('rotates the invite link and shows the new one once', async () => {
    const { api } = await renderAt(DETAIL, ['OPERATIONS_ADMIN'], {
      ...detailHandlers({ status: 'ACTIVE' }),
      [`POST /admin/campaigns/${CAMPAIGN_ID}/rotate-invite`]: () =>
        ok({
          campaign: campaign({ status: 'ACTIVE', tokenHint: 'Zz9a' }),
          invitePath: '/campaign/new-token-456',
        }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rotate invite link' }));
    expect(screen.getByText(/The current link stops working immediately/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Link was shared publicly');
    await user.click(screen.getByRole('button', { name: 'Rotate link' }));
    const panel = await screen.findByRole('region', {
      name: 'Invite link for Globex backend hiring',
    });
    expect((within(panel).getByRole('textbox') as HTMLInputElement).value).toMatch(
      /\/campaign\/new-token-456$/,
    );
    expect(screen.getByText('Starts with Zz9a…')).toBeInTheDocument();
    expect(bodyOf(api, `POST /admin/campaigns/${CAMPAIGN_ID}/rotate-invite`)).toEqual({
      reason: 'Link was shared publicly',
    });
  });

  it('edits the editable settings with a reason', async () => {
    const { api } = await renderAt(DETAIL, ['OPERATIONS_ADMIN'], {
      ...detailHandlers({ status: 'ACTIVE' }),
      [`PUT /admin/campaigns/${CAMPAIGN_ID}`]: (body) =>
        ok(
          campaign({
            status: 'ACTIVE',
            maxCandidates: (body as { maxCandidates: number }).maxCandidates,
          }),
        ),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit settings' }));
    const limit = screen.getByLabelText('Candidate limit');
    await user.clear(limit);
    await user.type(limit, '80');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a reason of 3–300 characters.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'More applicants expected');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Campaign settings saved.')).toBeInTheDocument();
    expect(bodyOf(api, `PUT /admin/campaigns/${CAMPAIGN_ID}`)).toMatchObject({
      name: 'Globex backend hiring',
      maxCandidates: 80,
      sponsoredCredits: 40,
      candidateSeesReport: true,
      reason: 'More applicants expected',
    });
  });
});

describe('campaign results', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the grid, filters it and downloads exports with the bearer token', async () => {
    const download = vi.fn(
      async () =>
        new Response('a,b\n', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="results.csv"' },
        }),
    );
    vi.stubGlobal('fetch', download);
    const { api, router } = await renderAt(DETAIL, ['OPERATIONS_ADMIN'], {
      ...detailHandlers(),
      [`GET /admin/campaigns/${CAMPAIGN_ID}/results`]: () =>
        ok(
          results([
            resultRow(),
            resultRow({
              applicationId: 'app2',
              interviewId: null,
              candidate: { userId: 'user-8', name: null, email: 'ravi@example.com' },
              status: 'JOINED',
              completedAt: null,
              overall: null,
              band: null,
              confidence: null,
              dimensions: {},
              flagged: true,
            }),
          ]),
        ),
    });
    const table = await screen.findByRole('table', { name: '2 candidates' });
    expect(within(table).getByRole('columnheader', { name: 'API design' })).toBeInTheDocument();
    const asha = within(table).getByRole('row', { name: /Asha Rao/ });
    expect(within(asha).getByText('82')).toBeInTheDocument();
    expect(within(asha).getByText('Ready with gaps')).toBeInTheDocument();
    expect(within(asha).getByText('High')).toBeInTheDocument();
    const ravi = within(table).getByRole('row', { name: /ravi@example.com/ });
    expect(within(ravi).getByText('Flagged')).toBeInTheDocument();
    expect(within(ravi).queryByRole('link')).not.toBeInTheDocument();
    expect(resultQueries(api)[0]).toEqual({});

    const user = userEvent.setup();
    const filters = screen.getByRole('search', { name: 'Result filters' });
    await user.selectOptions(within(filters).getByLabelText('Status'), 'COMPLETED');
    await user.type(within(filters).getByLabelText('Minimum overall'), '70');
    await user.selectOptions(within(filters).getByLabelText('Dimension'), 'debugging');
    await user.type(within(filters).getByLabelText('Minimum score'), '60');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    const expected = { status: 'COMPLETED', minOverall: '70', dimension: 'debugging:60' };
    await expect.poll(() => resultQueries(api).at(-1)).toEqual(expected);
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual(expected);

    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [csvUrl, csvInit] = download.mock.calls[0] as unknown as [string, RequestInit];
    const csv = new URL(csvUrl);
    expect(csv.pathname).toBe(`/api/v1/admin/campaigns/${CAMPAIGN_ID}/results.csv`);
    expect(Object.fromEntries(csv.searchParams)).toEqual(expected);
    expect(csvInit.headers).toEqual({ Authorization: 'Bearer access-token' });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Download package (ZIP)' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    const [zipUrl] = download.mock.calls[1] as unknown as [string];
    expect(new URL(zipUrl).pathname).toBe(`/api/v1/admin/campaigns/${CAMPAIGN_ID}/package.zip`);
  });

  it('shows the server message when an export is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_FAILED',
                message: 'Packages hold up to 500 candidates. Export the CSV instead.',
                requestId: 'r1',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await renderAt(DETAIL, ['OPERATIONS_ADMIN'], detailHandlers());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Download package (ZIP)' }));
    expect(
      await screen.findByText('Packages hold up to 500 candidates. Export the CSV instead.'),
    ).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
