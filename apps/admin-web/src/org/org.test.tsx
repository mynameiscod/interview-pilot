import {
  orgPermissionsFor,
  permissionsFor,
  type AdminMeResponse,
  type OrgMeResponse,
  type OrgResultRow,
  type OrgRole,
  type OrgType,
} from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../app/routes';
import { loadAdminUser } from '../app/session';
import { campaign } from '../features/campaigns/test-fixtures';
import { initI18n } from '../i18n';
import { OrgManagerProvider } from './guards';

const CAMPAIGN = '64b0000000000000000000c1';
const APP = '64b0000000000000000000a1';

function orgMe(role: OrgRole, type: OrgType = 'EMPLOYER'): OrgMeResponse {
  return {
    ...makeUser({ id: 'member-1', email: 'owner@acme.test' }),
    org: { id: 'org-1', name: 'Acme Labs', type, mfaRequired: false },
    orgRole: role,
    orgPermissions: orgPermissionsFor(role),
    mfaEnabled: false,
  };
}

const row = (overrides: Partial<OrgResultRow> = {}): OrgResultRow => ({
  applicationId: APP,
  interviewId: 'i1',
  candidate: { userId: 'u1', name: 'Asha Rao', email: 'asha@example.com' },
  status: 'COMPLETED',
  joinedAt: new Date().toISOString(),
  completedAt: null,
  overall: 81,
  band: 'READY',
  confidence: 'HIGH',
  scoreRevision: 0,
  dimensions: { 'api-design': 80 },
  flagged: false,
  stage: 'NEW',
  scorecardAverage: 4.5,
  scorecards: 2,
  notes: 1,
  tags: null,
  identity: 'CAPTURED',
  ...overrides,
});

const orgCampaign = campaign({
  id: CAMPAIGN,
  name: 'Acme backend hiring',
  orgId: 'org-1',
  status: 'ACTIVE',
});
const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 25 });

async function renderAt(
  path: string,
  handlers: Parameters<typeof fakeApi>[0] = {},
  opts: { admin?: AdminMeResponse | null } = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () =>
      opts.admin ? ok(makeSession(opts.admin)) : fail(401, 'UNAUTHENTICATED'),
    'GET /admin/me': () => ok(opts.admin),
    'POST /org/auth/refresh': () => fail(401, 'UNAUTHENTICATED'),
    'GET /org/auth/providers': () =>
      ok({ google: { enabled: false }, email: { enabled: true }, mobile: { enabled: false } }),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const orgManager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'org',
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
          <OrgManagerProvider manager={orgManager}>
            <RouterProvider router={router} />
          </OrgManagerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api, router };
}

/** An org session for the given role (the org refresh cookie is valid). */
const signedIn = (role: OrgRole, type: OrgType = 'EMPLOYER') => ({
  'POST /org/auth/refresh': () => ok(makeSession(orgMe(role, type))),
  'GET /org/me': () => ok(orgMe(role, type)),
});

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.findLast((c) => c.key === key)!.body;

describe('org portal access', () => {
  it('sends signed-out visitors to the org sign-in, which uses the org endpoints', async () => {
    const { router, api } = await renderAt('/org');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to your organisation' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/org/login');
    await userEvent.type(screen.getByLabelText(/email/i), 'owner@acme.test');
    await userEvent.click(screen.getByRole('button', { name: /send code|continue/i }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.key === 'POST /org/auth/otp/request')).toBe(true),
    );
    expect(api.calls.some((c) => c.key === 'POST /admin/auth/otp/request')).toBe(false);
  });

  it('never treats a staff session as an org session', async () => {
    const admin = {
      ...makeUser({ id: 'a1', email: 'root@codebegun.com', adminRoles: ['SUPER_ADMIN'] }),
      permissions: [...permissionsFor(['SUPER_ADMIN'])],
    };
    const { router } = await renderAt('/org', {}, { admin });
    await screen.findByRole('heading', { name: 'Sign in to your organisation' });
    expect(router.state.location.pathname).toBe('/org/login');
  });

  it('shows owners their campaigns with the org navigation; colleges get cohort readiness', async () => {
    await renderAt('/org', {
      ...signedIn('ORG_OWNER', 'COLLEGE'),
      'GET /org/campaigns': () => ok(page([orgCampaign])),
    });
    expect(await screen.findByRole('link', { name: 'Acme backend hiring' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Organisation navigation' });
    for (const name of ['Campaigns', 'Cohort readiness', 'Team', 'Integrations']) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /new campaign/i })).toBeInTheDocument();
  });

  it('keeps viewers read-only', async () => {
    await renderAt('/org/integrations', signedIn('ORG_VIEWER'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not include this section/);
    const nav = screen.getByRole('navigation', { name: 'Organisation navigation' });
    expect(within(nav).queryByRole('link', { name: 'Integrations' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Cohort readiness' })).toBeNull();
  });
});

describe('campaign pipeline', () => {
  const handlers = {
    ...signedIn('ORG_RECRUITER'),
    [`GET /org/campaigns/${CAMPAIGN}`]: () => ok(orgCampaign),
    [`GET /org/campaigns/${CAMPAIGN}/results`]: () =>
      ok({
        campaignId: CAMPAIGN,
        dimensions: [{ key: 'api-design', name: 'API design' }],
        rows: [
          row(),
          row({
            applicationId: '64b0000000000000000000a2',
            candidate: { userId: 'u2', name: 'Ravi', email: 'ravi@example.com' },
          }),
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        stages: { NEW: 2, SHORTLISTED: 0, ON_HOLD: 0, REJECTED: 0, HIRED: 0 },
      }),
    [`POST /org/campaigns/${CAMPAIGN}/candidates/stage`]: () => ok({ changed: 2 }),
  };

  it('lists consenting candidates and moves a selection to a stage', async () => {
    const { api } = await renderAt(`/org/campaigns/${CAMPAIGN}`, handlers);
    expect(await screen.findByRole('link', { name: 'Asha Rao' })).toBeInTheDocument();
    expect(screen.getByText(/agreed to share this interview/)).toBeInTheDocument();
    expect(screen.getAllByText('4.5 (2 reviews)')).toHaveLength(2);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Asha Rao' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Ravi' }));
    await userEvent.selectOptions(screen.getByLabelText('Move to…'), 'HIRED');
    await userEvent.click(screen.getByRole('button', { name: 'Move selected' }));
    expect(await screen.findByText('2 candidates moved.')).toBeInTheDocument();
    expect(bodyOf(api, `POST /org/campaigns/${CAMPAIGN}/candidates/stage`)).toEqual({
      stage: 'HIRED',
      note: null,
      applicationIds: [APP, '64b0000000000000000000a2'],
    });
  });

  it('checks a CSV of invites before sending only the valid rows', async () => {
    const valid = [
      {
        email: 'ravi@example.com',
        name: 'Ravi',
        language: 'te',
        tags: { batch: null, branch: null, year: null },
      },
    ];
    const { api } = await renderAt(`/org/campaigns/${CAMPAIGN}?tab=invites`, {
      ...handlers,
      [`GET /org/campaigns/${CAMPAIGN}/invites`]: () =>
        ok({
          ...page([]),
          pageSize: 50,
          counts: {
            PENDING: 0,
            SENT: 3,
            OPENED: 1,
            JOINED: 2,
            COMPLETED: 1,
            FAILED: 0,
            REVOKED: 0,
          },
        }),
      [`POST /org/campaigns/${CAMPAIGN}/invites/preview`]: () =>
        ok({
          valid,
          errors: [{ line: 3, message: '"bad" is not a valid email address.' }],
          duplicates: ['asha@example.com'],
        }),
      [`POST /org/campaigns/${CAMPAIGN}/invites`]: () => ok({ created: 1, skipped: [] }),
    });
    const input = await screen.findByLabelText('Invite from a CSV file');
    await userEvent.upload(
      input,
      new File(['email,name,language\nravi@example.com,Ravi,te\nbad,,\n'], 'invites.csv', {
        type: 'text/csv',
      }),
    );
    expect(
      await screen.findByText('1 valid, 1 with errors, 1 already invited or repeated.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Line 3: "bad" is not a valid email address.')).toBeInTheDocument();
    expect(bodyOf(api, `POST /org/campaigns/${CAMPAIGN}/invites/preview`)).toEqual({
      csv: 'email,name,language\nravi@example.com,Ravi,te\nbad,,\n',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 candidate' }));
    expect(await screen.findByText('1 invite queued.')).toBeInTheDocument();
    expect(bodyOf(api, `POST /org/campaigns/${CAMPAIGN}/invites`)).toEqual({ invites: valid });
  });
});

describe('candidate review', () => {
  it('saves a scorecard, adds notes and records the identity decision', async () => {
    const detail = {
      row: row(),
      employerView: 'SCORES',
      report: null,
      stageHistory: [],
      notes: [],
      scorecards: [],
      criteria: [
        { key: 'communication', label: 'Communication' },
        { key: 'role-fit', label: 'Role fit' },
      ],
      identity: {
        status: 'CAPTURED',
        imagePaths: { selfie: null, idDocument: null, interviewFrame: null },
        capturedAt: new Date().toISOString(),
        retentionExpiresAt: new Date().toISOString(),
        decision: null,
      },
    };
    const base = `/org/campaigns/${CAMPAIGN}/candidates/${APP}`;
    const { api } = await renderAt(base, {
      ...signedIn('ORG_OWNER'),
      [`GET ${base}`]: () => ok(detail),
      [`PUT ${base}/scorecard`]: () => ok({}),
      [`POST ${base}/notes`]: () => ok({}),
    });
    expect(await screen.findByRole('heading', { name: 'Asha Rao' })).toBeInTheDocument();
    expect(screen.getByText(/shares scores only/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is matched automatically/)).toBeInTheDocument();

    const save = screen.getByRole('button', { name: 'Save scorecard' });
    expect(save).toBeDisabled();
    const communication = screen.getByRole('group', { name: 'Communication' });
    await userEvent.click(within(communication).getByLabelText('4'));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Role fit' })).getByLabelText('5'),
    );
    await userEvent.selectOptions(screen.getByLabelText('Recommendation'), 'STRONG_YES');
    await userEvent.click(save);
    await waitFor(() =>
      expect(bodyOf(api, `PUT ${base}/scorecard`)).toEqual({
        ratings: { communication: 4, 'role-fit': 5 },
        recommendation: 'STRONG_YES',
        comment: null,
      }),
    );

    await userEvent.type(screen.getByLabelText('Add a note'), 'Strong answers, @ravi please check');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(bodyOf(api, `POST ${base}/notes`)).toEqual({
        body: 'Strong answers, @ravi please check',
      }),
    );
  });
});
