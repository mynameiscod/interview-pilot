import { WORKER_STEP_TIMEOUT } from '../support/env';
import { expect, signUpCandidate, test } from '../support/fixtures';
import { acceptAllConsents, passDeviceCheck, setUpRoleOnlyInterview } from '../support/interview';

/**
 * A recorded video interview in a real browser with Chromium's fake camera
 * and microphone: the camera device check, consent to recording, then the
 * room shows the self-view and the recording indicator, and the first
 * MediaRecorder segment (part 0, with its container header) is uploaded.
 */
test('video interview: camera check → recording consent → recording starts', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit has no fake camera for automated tests.');
  test.setTimeout(WORKER_STEP_TIMEOUT + 180_000);
  await signUpCandidate(page, { name: 'Divya E2E' });
  await setUpRoleOnlyInterview(page, 'Video');

  await passDeviceCheck(page, 'Video');
  // The standard template makes recording optional: the candidate chooses it here.
  const recording = page.getByRole('group', { name: /Recording/ });
  await expect(recording.getByText('Optional', { exact: true })).toBeVisible();
  await acceptAllConsents(page);
  await expect(page.getByText(/This is a video interview/)).toBeVisible();

  const firstSegment = page.waitForRequest(
    (req) => req.method() === 'POST' && /\/media\/segments\/0\?part=0$/.test(req.url()),
    // The recorder hands over a segment every 10 s (MEDIA_LIMITS.timesliceMs).
    { timeout: 10_000 + 60_000 },
  );
  await page.getByRole('button', { name: 'Start interview' }).click();

  // ---- The room: self-view and the recording indicator ----
  await expect(page).toHaveURL(/\/room$/);
  const selfView = page.getByRole('complementary', { name: 'Your camera' });
  await expect(selfView).toBeVisible({ timeout: 60_000 });
  await expect(selfView.locator('video')).toBeVisible();
  await expect(page.getByText('Recording', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // ---- The first 10 s segment reaches the server ----
  const segment = await firstSegment;
  expect(segment.headers()['content-type']).toBe('video/webm');
  const stored = await segment.response();
  expect(stored?.status()).toBe(201);
  // It starts the recorder's container (the EBML header), so this part plays on its own.
  const body = segment.postDataBuffer();
  expect(body?.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
});
