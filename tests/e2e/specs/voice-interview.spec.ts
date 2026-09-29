import { WORKER_STEP_TIMEOUT } from '../support/env';
import { expect, signUpCandidate, test } from '../support/fixtures';
import { acceptAllConsents, passDeviceCheck, setUpRoleOnlyInterview } from '../support/interview';

/**
 * A voice interview in a real browser: Chromium's fake microphone feeds the
 * device check and the recorded answer; the mock TTS reads the question and
 * the mock STT transcribes the answer (a labelled placeholder for real audio).
 * Device check → consent → start → record → review → submit.
 */
test('voice interview: device check → consent → record → review → submit', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit has no fake microphone for automated tests.');
  test.setTimeout(WORKER_STEP_TIMEOUT + 180_000);
  await signUpCandidate(page, { name: 'Kiran E2E' });
  await setUpRoleOnlyInterview(page, 'Voice');

  await passDeviceCheck(page, 'Voice');
  await acceptAllConsents(page);
  await expect(page.getByText(/This is a voice interview/)).toBeVisible();
  const spoken = page.waitForResponse(
    (res) => /\/questions\/[^/]+\/audio$/.test(res.url()) && res.status() === 200,
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'Start interview' }).click();

  // ---- The room: the question is spoken (mock TTS) and shown as captions ----
  await expect(page).toHaveURL(/\/room$/);
  await expect(page.locator('#room-question-text')).toBeVisible({ timeout: 60_000 });
  await spoken;

  // ---- Record an answer ----
  const start = page.getByRole('button', { name: 'Start answering' });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const done = page.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled();
  // Long enough to be a real answer (500 ms minimum), short enough to keep the test quick.
  await page.waitForTimeout(3_000);
  const transcribed = page.waitForResponse(
    (res) => res.url().endsWith('/voice/transcribe') && res.request().method() === 'POST',
  );
  await done.click();
  expect((await transcribed).status()).toBe(200);

  // ---- Review what was heard, then submit it as the answer ----
  await expect(page.getByRole('heading', { name: "Here's what we heard" })).toBeVisible();
  await expect(page.getByText(/\[mock\] Spoken answer of about \d+ seconds?\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record again' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit answer' }).click();

  // The server's transcript became the first answer.
  await expect(page.getByRole('button', { name: 'Transcript (1 question)' })).toBeVisible({
    timeout: 60_000,
  });
});
