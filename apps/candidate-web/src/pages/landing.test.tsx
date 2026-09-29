import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/common.json';
import { renderRoute } from '../test/render';
import { englishSeoStrings } from '../seo/seo-strings';
import { LANDING_FAQ } from './landing-content';

describe('landing page', () => {
  it('renders every marketing section with a labelled heading', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1, name: en.landing.hero.title });
    for (const name of [
      'How it works',
      'What you get',
      'Practise in English, Hindi or Telugu',
      'Simple, credit-based pricing',
      'Your data, your choice',
      'Frequently asked questions',
      'Ready to see where you stand?',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Coding in a real editor' })).toBeInTheDocument();
    const languages = screen.getByRole('list', { name: 'Supported languages' });
    expect(within(languages).getAllByRole('listitem')).toHaveLength(3);
  });

  it('links the calls to action to sign-in and pricing', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    // "Get started" stays unique: the end-to-end specs select it by name.
    expect(screen.getAllByRole('link', { name: 'Get started' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Start practising' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.getByRole('link', { name: 'See plans and prices' })).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(screen.getByRole('link', { name: 'See how it works' })).toHaveAttribute(
      'href',
      '#how-it-works',
    );
  });

  it('opens and closes FAQ answers', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    const faq = screen.getByRole('region', { name: 'Frequently asked questions' });
    expect(faq.querySelectorAll('details')).toHaveLength(LANDING_FAQ.length);

    const question = screen.getByText(en.landing.faq.freeQ);
    const details = question.closest('details')!;
    expect(details).not.toHaveAttribute('open');

    await userEvent.click(question);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(en.landing.faq.freeA)).toBeVisible();

    await userEvent.click(question);
    expect(details).not.toHaveAttribute('open');
  });

  it('shows exactly the FAQ that the prerendered FAQPage data describes', async () => {
    await renderRoute('/');
    await screen.findByRole('heading', { level: 1 });
    const faq = screen.getByRole('region', { name: 'Frequently asked questions' });
    const shown = [...faq.querySelectorAll('details')].map((d) => ({
      question: d.querySelector('summary')!.textContent,
      answer: d.querySelector('p')!.textContent,
    }));
    expect(shown).toEqual(englishSeoStrings().faq);
  });

  it('renders the new sections in Hindi', async () => {
    await renderRoute('/', { lng: 'hi' });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'अक्सर पूछे जाने वाले सवाल' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'प्लान और कीमतें देखें' })).toHaveAttribute(
      'href',
      '/pricing',
    );
  });
});
