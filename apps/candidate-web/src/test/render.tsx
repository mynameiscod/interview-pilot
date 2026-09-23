import type { UiLocale } from '@cbi/shared-types';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../app/routes';
import { initI18n } from '../i18n';

/** Renders the real route table at `path` with a deterministic locale. */
export async function renderRoute(path: string, lng: UiLocale = 'en') {
  const i18n = await initI18n({ detect: false, lng });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  return { ...utils, i18n, router };
}
