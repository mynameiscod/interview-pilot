import { adminNav, expect, signInAdmin, test } from '../support/fixtures';
import { URLS } from '../support/env';

const KPI_TILES = [
  'Registrations',
  'Active users',
  'Interviews started',
  'Interviews completed',
  'Completion rate',
  'Revenue',
  'AI cost',
];

test('operations admin sees the analytics dashboard and system health', async ({ page }) => {
  await signInAdmin(page, ['OPERATIONS_ADMIN']);

  await expect(page.getByRole('heading', { name: 'Key metrics' })).toBeVisible();
  for (const name of KPI_TILES) {
    await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Cohort funnel' })).toBeVisible();

  await (await adminNav(page)).getByRole('link', { name: 'System health' }).click();
  await expect(page.getByRole('heading', { name: 'System health', level: 1 })).toBeVisible();
  const deps = page.getByRole('region', { name: 'Dependencies' });
  await expect(deps).toBeVisible();
  for (const dep of ['mongodb', 'redis']) {
    await expect(deps.getByRole('listitem').filter({ hasText: dep })).toContainText('OK');
  }
  await expect(page.getByRole('region', { name: 'Workers' })).toBeVisible();
});

test('a finance admin does not get the System section', async ({ page }) => {
  await signInAdmin(page, ['FINANCE_ADMIN']);
  // Finance admins have analytics…
  await expect(page.getByRole('heading', { name: 'Key metrics' })).toBeVisible();

  // …but no System entries in the navigation…
  const nav = await adminNav(page);
  await expect(nav.getByRole('link', { name: 'Costs & margin' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'System health' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Feature flags' })).toHaveCount(0);
  await expect(nav.getByText('System', { exact: true })).toHaveCount(0);

  // …and a direct visit is refused.
  await page.goto(`${URLS.admin}/system/health`);
  await expect(
    page.getByRole('heading', { name: 'You do not have access to this section' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System health' })).toHaveCount(0);
});
