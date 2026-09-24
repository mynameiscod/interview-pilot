import { expect, test } from '../support/fixtures';
import { URLS } from '../support/env';

test('pricing page lists the plans', async ({ page }) => {
  await page.goto(`${URLS.candidate}/pricing`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible();
  // Each plan is a card headed by its name; every account has the free plan.
  const plans = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(plans.first()).toBeVisible();
  expect(await plans.count()).toBeGreaterThan(0);
  await expect(page.getByText(/interview credits?$/).first()).toBeVisible();
});

test('switching the language to Hindi translates the page', async ({ page }) => {
  await page.goto(URLS.candidate);
  await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Language' }).selectOption('hi');

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'असली इंटरव्यू से पहले जानिए कि आप ठीक कहाँ खड़े हैं।',
    }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'शुरू करें' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'कीमतें' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

  // The choice is remembered across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: 'शुरू करें' })).toBeVisible();
});
