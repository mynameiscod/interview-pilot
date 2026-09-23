import type { UiLocale } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../app/routes';
import { initI18n } from '../i18n';
import { fakeApi } from '@cbi/web-core/testing';

/**
 * Renders the real route table and providers at `path` with a deterministic
 * locale and a fake API (signed out unless the fake says otherwise).
 */
export async function renderRoute(
  path: string,
  opts: { lng?: UiLocale; api?: ReturnType<typeof fakeApi> } = {},
) {
  const i18n = await initI18n({ detect: false, lng: opts.lng ?? 'en' });
  const api = opts.api ?? fakeApi();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'candidate',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider manager={manager}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...utils, i18n, router, api };
}
