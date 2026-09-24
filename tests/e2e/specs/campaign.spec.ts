import {
  adminNav,
  completeOnboarding,
  completeOtpSignIn,
  expect,
  newDeviceContext,
  signInAdmin,
  test,
  uniqueEmail,
} from '../support/fixtures';
import { URLS, WORKER_STEP_TIMEOUT } from '../support/env';

test('admin creates and activates a campaign; a candidate joins by the invite link', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(WORKER_STEP_TIMEOUT + 120_000);
  const campaignName = `Backend hiring ${Date.now()}`;

  // ---- Admin (operations) creates a draft campaign ----
  await signInAdmin(page, ['OPERATIONS_ADMIN']);
  await (await adminNav(page)).getByRole('link', { name: 'Campaigns' }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New campaign' }).click();

  const form = page.getByRole('form', { name: 'New campaign' });
  await form.getByLabel('Campaign name').fill(campaignName);
  await form.getByLabel('Company name').fill('Acme Labs');
  await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Backend Engineer' });
  const template = form.getByLabel('Interview type');
  const standard = template.locator('option', { hasText: 'standard-practice' });
  await expect(standard).toHaveCount(1);
  await template.selectOption((await standard.getAttribute('value'))!);
  await expect(form.getByRole('checkbox', { name: 'Text' })).toBeChecked();
  await form.getByRole('checkbox', { name: 'English' }).check();
  await form.getByRole('button', { name: 'Create draft campaign' }).click();

  // ---- The invite link is shown once: copy it ----
  const invite = page.getByRole('region', { name: `Invite link for ${campaignName}` });
  await expect(invite).toBeVisible();
  await invite.getByRole('button', { name: 'Copy link' }).click();
  // Clipboard access depends on the browser's permissions; either outcome is reported.
  await expect(
    invite.getByText(/^(Copied to the clipboard\.|Could not copy automatically\..*)$/),
  ).toBeVisible();
  const inviteUrl = await invite.getByLabel('Invite link').inputValue();
  expect(inviteUrl).toMatch(new RegExp(`^${URLS.candidate}/campaign/[^/]+$`));

  // ---- Activate it ----
  await invite.getByRole('link', { name: 'Open campaign' }).click();
  await expect(page.getByRole('heading', { name: campaignName, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByLabel('Reason (recorded in the audit log)').fill('E2E launch');
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('The campaign is now Active.')).toBeVisible();

  // ---- Candidate opens the link, signs up and joins ----
  const candidateContext = await newDeviceContext(browser, testInfo);
  try {
    const cand = await candidateContext.newPage();
    await cand.goto(inviteUrl);
    await expect(cand.getByRole('heading', { name: campaignName, level: 1 })).toBeVisible();
    await expect(cand.getByText('Interview invitation from Acme Labs')).toBeVisible();
    await cand.getByRole('link', { name: 'Join interview' }).click();

    await completeOtpSignIn(cand, uniqueEmail('campaign'));
    await completeOnboarding(cand, 'Kiran E2E');

    // Sign-in and onboarding return the candidate to the invitation.
    await expect(cand).toHaveURL(inviteUrl);
    await cand.getByRole('button', { name: 'Join interview' }).click();

    await expect(cand).toHaveURL(/\/app\/interviews\/[^/]+\/analysis$/);
    const banner = cand.getByRole('complementary', { name: 'Company interview' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Invited by Acme Labs');
    await expect(banner).toContainText(campaignName);
    await expect(cand.getByRole('heading', { name: 'Your interview plan' })).toBeVisible();
    await expect(cand.getByRole('link', { name: 'Looks right — continue' })).toBeVisible({
      timeout: WORKER_STEP_TIMEOUT,
    });
  } finally {
    await candidateContext.close();
  }
});
