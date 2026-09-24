import type {
  AdminMeResponse,
  AdminRole,
  BlueprintSummary,
  Permission,
  RoleSummary,
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
  blueprint,
  blueprintContent,
  company,
  role,
  template,
  templateContent,
} from './test-fixtures';

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

describe('library navigation', () => {
  it('groups Roles, Companies and Templates under Library for content admins', async () => {
    await renderAt('/', ['CONTENT_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const library = within(nav).getByRole('list', { name: 'Library' });
    for (const name of ['Roles', 'Companies', 'Templates']) {
      expect(within(library).getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('hides the library from admins without library.read', async () => {
    await renderAt('/roles', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByText('Library')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Templates' })).not.toBeInTheDocument();
  });
});

describe('roles', () => {
  it('lists roles with their active blueprint version', async () => {
    await renderAt('/roles', ['CONTENT_ADMIN'], {
      'GET /admin/roles': () =>
        ok([
          role(),
          role({
            id: 'r2',
            title: 'QA Engineer',
            slug: 'qa-engineer',
            activeBlueprintId: null,
            active: false,
          }),
        ]),
      'GET /admin/blueprints': () => ok([blueprint({ version: 2 })]),
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /Backend Engineer/ });
    expect(within(row).getByText('backend-engineer')).toBeInTheDocument();
    expect(await within(row).findByText('v2')).toBeInTheDocument();
    const qa = within(table).getByRole('row', { name: /QA Engineer/ });
    expect(within(qa).getByText('Inactive')).toBeInTheDocument();
    expect(within(qa).getByText('None')).toBeInTheDocument();
  });

  it('validates a new role, suggests the slug and explains a duplicate slug', async () => {
    const { api } = await renderAt('/roles', ['CONTENT_ADMIN'], {
      'GET /admin/roles': () => ok([role()]),
      'GET /admin/blueprints': () => ok([]),
      'POST /admin/roles': () => fail(409, 'CONFLICT'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    const title = screen.getByLabelText('Title');
    expect(title).toHaveAccessibleDescription('Enter a title of 2–120 characters.');

    await user.type(title, 'Data Engineer');
    expect(screen.getByLabelText('Slug')).toHaveValue('data-engineer');
    await user.selectOptions(screen.getByLabelText('Family'), 'DATA');
    await user.type(screen.getByLabelText('Aliases (optional)'), 'ETL developer, Data eng');
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    expect(
      await screen.findByText('That slug is already used by another role.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toHaveAttribute('aria-invalid', 'true');
    expect(bodyOf(api, 'POST /admin/roles')).toEqual({
      title: 'Data Engineer',
      slug: 'data-engineer',
      family: 'DATA',
      defaultSeniority: 'MID',
      aliases: ['ETL developer', 'Data eng'],
      active: true,
    });
  });

  it('hides management controls without library.manage', async () => {
    await renderAt('/roles', ['library.read'], {
      'GET /admin/roles': () => ok([role()]),
      'GET /admin/blueprints': () => ok([]),
    });
    expect(await screen.findByText('backend-engineer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Backend Engineer' })).not.toBeInTheDocument();
  });
});

describe('role blueprints', () => {
  const draftContent = () => {
    const content = blueprintContent();
    content.competencies[0]!.weight = 45;
    content.competencies[1]!.weight = 25;
    return content;
  };
  const history = (): BlueprintSummary[] => [
    blueprint({
      id: 'b2',
      version: 2,
      status: 'DRAFT',
      content: draftContent(),
      activatedAt: null,
    }),
    blueprint(),
  ];
  const handlers = (extra: Parameters<typeof fakeApi>[0] = {}) => ({
    'GET /admin/roles': () => ok([role()]),
    'GET /admin/roles/r1/blueprints': () => ok(history()),
    ...extra,
  });

  it('shows the readable blueprint and a diff against the active version', async () => {
    await renderAt('/roles/r1', ['CONTENT_ADMIN'], handlers());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View v1' }));
    const viewer = screen.getByRole('article', { name: 'Blueprint v1' });
    expect(within(viewer).getByText('API design')).toBeInTheDocument();
    expect(within(viewer).getByText('Competencies (weights total 100)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Compare v2 with the active version' }));
    const diff = screen.getByRole('region', { name: 'Differences between v2 and active v1' });
    expect(within(diff).getAllByText('Changed')).toHaveLength(2);
    expect(within(diff).getByText('(+5)')).toBeInTheDocument();
    expect(within(diff).getByText('(-5)')).toBeInTheDocument();
  });

  it('requires a reason to activate a version and calls the endpoint', async () => {
    const { api } = await renderAt(
      '/roles/r1',
      ['CONTENT_ADMIN'],
      handlers({
        'POST /admin/blueprints/b2/activate': () => ok(blueprint({ id: 'b2', version: 2 })),
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate v2' }));
    const confirm = screen.getByRole('button', { name: 'Activate v2' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Reviewed with hiring team');
    await user.click(confirm);
    expect(
      await screen.findByText('v2 is now the active blueprint for Backend Engineer.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/blueprints/b2/activate')).toEqual({
      reason: 'Reviewed with hiring team',
    });
  });

  it('creates a new version from the active content with a live weight total', async () => {
    let reply = () =>
      fail(400, 'VALIDATION_FAILED', {
        issues: [{ path: 'content.competencies.0.name', message: 'Name is reserved' }],
      });
    const { api } = await renderAt(
      '/roles/r1',
      ['CONTENT_ADMIN'],
      handlers({ 'POST /admin/roles/r1/blueprints': () => reply() }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New blueprint version' }));
    expect(screen.getByText('Weights total 100 of 100.')).toBeInTheDocument();
    const json = screen.getByLabelText('Blueprint content (JSON)') as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual(blueprintContent());

    const weight = screen.getByLabelText('Weight for API design');
    await user.clear(weight);
    await user.type(weight, '50');
    expect(
      screen.getByText('Weights total 110 of 100 — they must total exactly 100.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'Rebalance');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('weights must sum to 100 (got 110)')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'POST /admin/roles/r1/blueprints')).toBe(false);

    const debugging = screen.getByLabelText('Weight for Debugging');
    await user.clear(debugging);
    await user.type(debugging, '20');
    expect(screen.getByText('Weights total 100 of 100.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    // Server validation issues are listed against the content.
    expect(await screen.findByText('Name is reserved')).toBeInTheDocument();

    reply = () => ({
      status: 201,
      body: { data: blueprint({ id: 'b3', version: 3, status: 'DRAFT' }) },
    });
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('v3 was saved as a draft.')).toBeInTheDocument();
    const body = api.calls.filter((c) => c.key === 'POST /admin/roles/r1/blueprints').at(-1)!
      .body as { content: ReturnType<typeof blueprintContent>; reason: string };
    expect(body.reason).toBe('Rebalance');
    expect(body.content.competencies.map((c) => c.weight)).toEqual([50, 20, 30]);
  });

  it('hides activation and new versions without library.manage', async () => {
    await renderAt('/roles/r1', ['library.read'], handlers());
    expect(await screen.findByRole('button', { name: 'View v2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate v2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New blueprint version' })).not.toBeInTheDocument();
  });
});

describe('AI-generated blueprints', () => {
  const generated = blueprint({
    id: 'g1',
    roleId: null,
    origin: 'AI_GENERATED',
    status: 'ACTIVE',
    generatedBy: { model: 'claude-opus-5', promptVersion: 3 },
    sourceJobTargetId: 'jt1',
  });

  it('promotes a generated blueprint into a role and opens the new draft', async () => {
    const roles: RoleSummary[] = [
      role(),
      role({ id: 'r2', title: 'Platform Engineer', slug: 'platform-engineer' }),
    ];
    const { api, router } = await renderAt('/blueprints', ['CONTENT_ADMIN'], {
      'GET /admin/blueprints': () => ok([generated]),
      'GET /admin/blueprints/g1': () => ok(generated),
      'GET /admin/roles': () => ok(roles),
      'POST /admin/blueprints/g1/promote': () => ({
        status: 201,
        body: { data: blueprint({ id: 'b7', roleId: 'r2', version: 1, status: 'DRAFT' }) },
      }),
      'GET /admin/roles/r2/blueprints': () =>
        ok([blueprint({ id: 'b7', roleId: 'r2', version: 1, status: 'DRAFT' })]),
    });
    const user = userEvent.setup();
    expect(await screen.findByText('claude-opus-5')).toBeInTheDocument();
    await user.click(
      screen.getByRole('link', { name: 'Review the blueprint for Backend Engineer' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'AI-generated blueprint: Backend Engineer' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Promote to role' }));
    const confirm = screen.getByRole('button', { name: 'Promote as draft' });
    await user.type(screen.getByLabelText(REASON), 'Good coverage');
    expect(confirm).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Role'), 'r2');
    await user.click(confirm);

    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/roles/r2');
    expect(await screen.findByRole('article', { name: 'Blueprint v1' })).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/blueprints/g1/promote')).toEqual({
      roleId: 'r2',
      reason: 'Good coverage',
    });
  });

  it('does not offer promotion without library.manage', async () => {
    await renderAt('/blueprints/g1', ['library.read'], {
      'GET /admin/blueprints/g1': () => ok(generated),
    });
    expect(
      await screen.findByRole('heading', { name: 'AI-generated blueprint: Backend Engineer' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Promote to role' })).not.toBeInTheDocument();
  });
});

describe('companies', () => {
  it('adds a verified pattern and submits the right body', async () => {
    const { api } = await renderAt('/companies', ['CONTENT_ADMIN'], {
      'GET /admin/companies': () => ok([company()]),
      'POST /admin/companies': () => ({
        status: 201,
        body: { data: company({ id: 'c2', name: 'Acme Corp', slug: 'acme-corp' }) },
      }),
    });
    const user = userEvent.setup();
    const table = await screen.findByRole('table');
    const globex = within(table).getByRole('row', { name: /Globex/ });
    expect(within(globex).getByText('1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New company' }));
    await user.type(screen.getByLabelText('Name'), 'Acme Corp');
    expect(screen.getByLabelText('Slug')).toHaveValue('acme-corp');
    await user.type(screen.getByLabelText('Website (optional)'), 'https://acme.example');
    await user.click(screen.getByLabelText('Engineering'));
    await user.click(screen.getByLabelText('Domain'));

    await user.click(screen.getByRole('button', { name: 'Add pattern' }));
    await user.type(screen.getByLabelText('Pattern 1 note'), 'Starts with a take-home exercise.');
    await user.selectOptions(screen.getByLabelText('Pattern 1 source'), 'EMPLOYER_PROVIDED');
    await user.type(screen.getByLabelText('Pattern 1 source URL (optional)'), 'not a url');
    await user.click(screen.getByRole('button', { name: 'Create company' }));
    expect(screen.getByLabelText('Pattern 1 source URL (optional)')).toHaveAccessibleDescription(
      'Enter a full http:// or https:// address.',
    );
    await user.clear(screen.getByLabelText('Pattern 1 source URL (optional)'));
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    expect(await screen.findByText('Acme Corp has been saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/companies')).toEqual({
      name: 'Acme Corp',
      slug: 'acme-corp',
      description: null,
      website: 'https://acme.example',
      roleFamilies: ['ENGINEERING'],
      allowedQuestionCategories: ['TECHNICAL', 'PROBLEM_SOLVING', 'COMMUNICATION', 'BEHAVIORAL'],
      active: true,
      verifiedPatterns: [
        {
          note: 'Starts with a take-home exercise.',
          sourceType: 'EMPLOYER_PROVIDED',
          sourceUrl: null,
        },
      ],
    });
  });

  it('shows who verified existing patterns and removes one on save', async () => {
    const { api } = await renderAt('/companies', ['CONTENT_ADMIN'], {
      'GET /admin/companies': () => ok([company()]),
      'PUT /admin/companies/c1': () => ok(company({ verifiedPatterns: [] })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Globex' }));
    expect(screen.getByText(/^Verified by admin-9 on /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove pattern 1' }));
    await user.click(screen.getByRole('button', { name: 'Save company' }));
    expect(await screen.findByText('Globex has been saved.')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/companies/c1')).toMatchObject({ verifiedPatterns: [] });
  });

  it('hides management controls without library.manage', async () => {
    await renderAt('/companies', ['library.read'], {
      'GET /admin/companies': () => ok([company()]),
    });
    expect(await screen.findByText('globex')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New company' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Globex' })).not.toBeInTheDocument();
  });
});

describe('templates', () => {
  const versions = () => [
    template(),
    template({ id: 't2', version: 2, status: 'DRAFT', activatedAt: null }),
  ];

  it('groups versions by key and shows a version’s rounds and policies', async () => {
    await renderAt('/templates', ['CONTENT_ADMIN'], {
      'GET /admin/templates': () => ok(versions()),
    });
    const group = await screen.findByRole('region', { name: 'standard-technical' });
    expect(
      within(group).getByText('Active: Standard technical interview (v1)'),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: 'View standard-technical v1' }));
    const viewer = screen.getByRole('article', { name: 'Template standard-technical v1' });
    expect(within(viewer).getByText('2 rounds, 25 min in total')).toBeInTheDocument();
    expect(within(viewer).getByText('Adaptive')).toBeInTheDocument();
    expect(within(viewer).getByText('35%')).toBeInTheDocument();
  });

  it('edits weights with a live total and saves a new version', async () => {
    const { api } = await renderAt('/templates', ['CONTENT_ADMIN'], {
      'GET /admin/templates': () => ok(versions()),
      'POST /admin/templates': () => ({
        status: 201,
        body: { data: template({ id: 't3', version: 3, status: 'DRAFT' }) },
      }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'New version of standard-technical' }),
    );
    expect(screen.getByText('Weights total 100%.')).toBeInTheDocument();
    const technical = screen.getByLabelText('Technical');
    await user.clear(technical);
    await user.type(technical, '30');
    expect(
      screen.getByText('Weights total 95% — they must total exactly 100%.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(REASON), 'More weight on domain');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText('must sum to 100 (got 95)')).toBeInTheDocument();

    const domain = screen.getByLabelText('Domain');
    await user.clear(domain);
    await user.type(domain, '15');
    expect(screen.getByText('Weights total 100%.')).toBeInTheDocument();
    const duration = screen.getByLabelText('Round 2 duration in minutes');
    await user.clear(duration);
    await user.type(duration, '25');
    expect(screen.getByText('Total duration: 30 min')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));

    expect(
      await screen.findByText('standard-technical v3 was saved as a draft.'),
    ).toBeInTheDocument();
    const expected = templateContent();
    expected.scoringPolicy.dimensionWeights = {
      ...expected.scoringPolicy.dimensionWeights,
      TECHNICAL: 30,
      DOMAIN: 15,
    };
    expected.rounds[1]!.durationSec = 1500;
    expect(bodyOf(api, 'POST /admin/templates')).toEqual({
      key: 'standard-technical',
      content: expected,
      reason: 'More weight on domain',
    });
  });

  it('activates a draft template version with a reason', async () => {
    const { api } = await renderAt('/templates', ['CONTENT_ADMIN'], {
      'GET /admin/templates': () => ok(versions()),
      'POST /admin/templates/t2/activate': () => ok(template({ id: 't2', version: 2 })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate standard-technical v2' }));
    const confirm = screen.getByRole('button', { name: 'Activate v2' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Approved');
    await user.click(confirm);
    expect(await screen.findByText('standard-technical v2 is now active.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/templates/t2/activate')).toEqual({ reason: 'Approved' });
  });

  it('hides management controls without library.manage', async () => {
    await renderAt('/templates', ['library.read'], {
      'GET /admin/templates': () => ok(versions()),
    });
    expect(await screen.findByRole('region', { name: 'standard-technical' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New template' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Activate standard-technical v2' }),
    ).not.toBeInTheDocument();
  });
});
