import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { routes } from './routes';

async function renderAt(path: string) {
  const i18n = await initI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </I18nextProvider>,
  );
}

describe('admin routes', () => {
  it('renders the dashboard with an honest empty state', async () => {
    await renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(
      screen.getByText(/Admin sign-in and role-based access arrive in Phase 1/),
    ).toBeInTheDocument();
  });

  it('shows the environment badge', async () => {
    await renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('Development')).toBeInTheDocument();
  });

  it('toggles the navigation on small screens', async () => {
    await renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders not-found for unknown routes', async () => {
    await renderAt('/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
