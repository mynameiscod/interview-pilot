import {
  completeOnboarding,
  completeOtpSignIn,
  expect,
  test,
  uniqueEmail,
} from '../support/fixtures';
import { URLS } from '../support/env';

test('landing → email OTP sign-in → onboarding → dashboard', async ({ page }) => {
  await page.goto(URLS.candidate);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Know exactly where you stand before the real interview.',
    }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in or create your account' })).toBeVisible();

  const email = uniqueEmail('signup');
  await completeOtpSignIn(page, email);

  await expect(page).toHaveURL(/\/onboarding/);
  await completeOnboarding(page, 'Ravi Kumar');

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Ravi Kumar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start an interview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent interviews' })).toBeVisible();

  // The session survives a reload (refresh cookie on the API origin).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome, Ravi Kumar' })).toBeVisible();
});
