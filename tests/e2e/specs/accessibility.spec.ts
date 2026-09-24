import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect, signInAdmin, signUpCandidate, test } from '../support/fixtures';
import { URLS, WORKER_STEP_TIMEOUT } from '../support/env';
import { runRoleOnlyTextInterview } from '../support/interview';

/**
 * Accessibility smoke: axe (WCAG 2.x A/AA rules) on key pages. The suite fails
 * on `serious` or `critical` violations; the full results are attached to the
 * test either way.
 */
async function expectNoSeriousViolations(page: Page, testInfo: TestInfo, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => ({
        target: n.target.join(' '),
        html: n.html.slice(0, 160),
        summary: n.failureSummary?.replace(/\s+/g, ' ').trim(),
      })),
    }));
  expect(serious, `serious/critical axe violations on ${label}`).toEqual([]);
}

test('landing page', async ({ page }, testInfo) => {
  await page.goto(URLS.candidate);
  await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'landing');
});

test('sign-in page', async ({ page }, testInfo) => {
  await page.goto(`${URLS.candidate}/login`);
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'sign-in');
});

test('pricing page', async ({ page }, testInfo) => {
  await page.goto(`${URLS.candidate}/pricing`);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'pricing');
});

test('report page', async ({ page }, testInfo) => {
  test.setTimeout(WORKER_STEP_TIMEOUT * 2 + 120_000);
  await signUpCandidate(page, { name: 'Axe E2E' });
  await runRoleOnlyTextInterview(page);
  await expect(page.getByRole('heading', { name: 'Overall readiness' })).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'report');
});

test('admin dashboard', async ({ page }, testInfo) => {
  await signInAdmin(page, ['OPERATIONS_ADMIN']);
  await expect(page.getByRole('heading', { name: 'Key metrics' })).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'admin-dashboard');
});
