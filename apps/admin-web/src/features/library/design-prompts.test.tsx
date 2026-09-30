import type { AdminMeResponse, AdminRole, DesignPromptSummary } from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';

const REASON = 'Reason (recorded in the audit log)';

const prompt = (overrides: Partial<DesignPromptSummary> = {}): DesignPromptSummary => ({
  id: 'dp1',
  key: 'short-link-service',
  version: 1,
  active: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  title: 'Short links for a marketing team',
  prompt: 'Design a short link service.\n\nMostly redirects.',
  difficulty: 'EASY',
  tags: ['caching'],
  focusAreas: ['How codes are generated'],
  considerations: ['Read-heavy traffic', 'Caching hot links'],
  ...overrides,
});

async function renderAt(roles: AdminRole[], handlers: Parameters<typeof fakeApi>[0] = {}) {
  const me: AdminMeResponse = {
    ...makeUser({ id: 'admin-1', email: 'content@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)],
  };
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(me),
    'GET /admin/design-prompts': () => ok([prompt()]),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const router = createMemoryRouter(routes, { initialEntries: ['/design-prompts'] });
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
  return api;
}

describe('system design prompts', () => {
  it('lists prompts and shows the rubric as hidden from candidates', async () => {
    await renderAt(['CONTENT_ADMIN']);
    const group = await screen.findByRole('region', { name: 'short-link-service' });
    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: 'View short-link-service v1' }));
    const viewer = screen.getByRole('article', { name: 'Design prompt short-link-service v1' });
    expect(within(viewer).getByText('How codes are generated')).toBeInTheDocument();
    expect(within(viewer).getByText('Caching hot links')).toBeInTheDocument();
    expect(within(viewer).getByText('Hidden — never shown to candidates')).toBeInTheDocument();
  });

  it('creates a new version with one focus area or consideration per line', async () => {
    const api = await renderAt(['CONTENT_ADMIN'], {
      'POST /admin/design-prompts': () => ({
        status: 201,
        body: { data: prompt({ id: 'dp2', version: 2, active: false }) },
      }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'New version from short-link-service v1' }),
    );
    const considerations = screen.getByLabelText('Considerations (the rubric)');
    await user.clear(considerations);
    await user.type(considerations, 'Read-heavy traffic{Enter}{Enter}  Abuse and rate limits  ');
    await user.type(screen.getByLabelText(REASON), 'Add abuse');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(
      await screen.findByText(
        'Created short-link-service v2 (inactive). Activate it so new interviews get it.',
      ),
    ).toBeInTheDocument();
    const body = api.calls.find((c) => c.key === 'POST /admin/design-prompts')!.body as {
      key: string;
      content: DesignPromptSummary;
    };
    expect(body.key).toBe('short-link-service');
    expect(body.content.considerations).toEqual(['Read-heavy traffic', 'Abuse and rate limits']);
    expect(body.content.focusAreas).toEqual(['How codes are generated']);
  });

  it('activates a version only with a reason', async () => {
    const api = await renderAt(['CONTENT_ADMIN'], {
      'GET /admin/design-prompts': () => ok([prompt({ active: false })]),
      'POST /admin/design-prompts/dp1/activate': () => ok(prompt()),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate short-link-service v1' }));
    await user.type(screen.getByLabelText(REASON), 'Reviewed');
    await user.click(screen.getByRole('button', { name: 'Activate short-link-service v1' }));
    expect(
      await screen.findByText(
        'short-link-service v1 is now active. New interviews get this version.',
      ),
    ).toBeInTheDocument();
    expect(
      api.calls.find((c) => c.key === 'POST /admin/design-prompts/dp1/activate')!.body,
    ).toEqual({ reason: 'Reviewed' });
  });
});
