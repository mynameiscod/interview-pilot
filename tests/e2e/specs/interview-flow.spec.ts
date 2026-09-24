import { expect, signUpCandidate, test } from '../support/fixtures';
import { WORKER_STEP_TIMEOUT } from '../support/env';
import { runRoleOnlyTextInterview } from '../support/interview';

test('role-only interview: wizard → analysis → text interview → report', async ({ page }) => {
  test.setTimeout(WORKER_STEP_TIMEOUT * 2 + 120_000);
  await signUpCandidate(page, { name: 'Meera E2E' });
  await runRoleOnlyTextInterview(page);

  // ---- Report: overall score/band and the PDF ----
  await expect(page.getByRole('heading', { name: 'Overall readiness' })).toBeVisible();
  await expect(page.getByRole('img', { name: /^Overall readiness / })).toBeVisible();

  const pdf = page.getByRole('button', { name: 'Download PDF' });
  await expect(async () => {
    if (!(await pdf.isVisible())) {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Overall readiness' })).toBeVisible();
    }
    await expect(pdf).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout: WORKER_STEP_TIMEOUT, intervals: [3_000] });
  const [download] = await Promise.all([page.waitForEvent('download'), pdf.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
});
