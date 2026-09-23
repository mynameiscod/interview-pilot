import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../test/render';

describe('candidate routes', () => {
  it('renders the landing page with its primary heading', async () => {
    await renderRoute('/');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /know exactly where you stand/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
  });

  it('provides a skip link and a labelled primary navigation', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('renders the not-found page for unknown routes', async () => {
    await renderRoute('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('renders the landing page in Telugu', async () => {
    await renderRoute('/', 'te');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'అసలు ఇంటర్వ్యూకి ముందే',
    );
    expect(document.documentElement.lang).toBe('te');
  });

  it('switches language from the header without reloading', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    await userEvent.selectOptions(screen.getByRole('combobox'), 'hi');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('असली इंटरव्यू'),
    );
  });

  it('renders the header logo from the central brand registry', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    const logo = screen.getByRole('img', { name: 'CodeBegun' });
    expect(logo).toHaveAttribute('src', '/brand/codebegun-logo.svg');
  });
});
