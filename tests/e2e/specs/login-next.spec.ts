import {
  completeOnboarding,
  completeOtpSignIn,
  expect,
  test,
  uniqueEmail,
} from '../support/fixtures';
import { URLS } from '../support/env';

// Sign-in (and onboarding for a new candidate) returns to the page that sent them there.
test('a new candidate returns to the ?next page after sign-in and onboarding', async ({ page }) => {
  await page.goto(`${URLS.candidate}/login?next=${encodeURIComponent('/pricing')}`);
  await completeOtpSignIn(page, uniqueEmail('next'));
  await expect(page).toHaveURL(/\/onboarding\?next=%2Fpricing$/);
  await completeOnboarding(page, 'Next E2E');
  await expect(page).toHaveURL(`${URLS.candidate}/pricing`);
});
