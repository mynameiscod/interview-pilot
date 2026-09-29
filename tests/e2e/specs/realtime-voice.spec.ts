import { setFeatureFlag } from '../support/data';
import { WORKER_STEP_TIMEOUT } from '../support/env';
import { expect, signUpCandidate, test } from '../support/fixtures';
import { acceptAllConsents, passDeviceCheck, setUpRoleOnlyInterview } from '../support/interview';

/**
 * Realtime conversational voice (flag `voice.realtime`) in Chromium with the
 * fake microphone (a periodic tone) and the mock streaming providers: the
 * mock speech service hears the tone as speech and transcribes it to a
 * labelled placeholder while the candidate "speaks". The answer is sent
 * with "Send now" (or after the grace window, whichever comes first), and
 * the next question is streamed in. The API caches flags for up to 15 s, so
 * the flag is switched on before the interview is set up.
 */
test.afterAll(async () => {
  await setFeatureFlag('voice.realtime', false);
});

test('realtime voice: live transcript → send → next question streams in', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit has no fake microphone for automated tests.');
  test.setTimeout(WORKER_STEP_TIMEOUT + 180_000);
  await setFeatureFlag('voice.realtime', true);
  await signUpCandidate(page, { name: 'Ravi E2E' });
  await setUpRoleOnlyInterview(page, 'Voice');
  await passDeviceCheck(page, 'Voice');
  await acceptAllConsents(page);
  await page.getByRole('button', { name: 'Start interview' }).click();

  // ---- The room: the first question is read aloud, then the microphone streams ----
  await expect(page).toHaveURL(/\/room$/);
  await expect(page.locator('#room-question-text')).toBeVisible({ timeout: 60_000 });
  const answer = page.getByRole('region', { name: 'Your spoken answer' });
  // Listening starts when the question has been read (or when the tone interrupts it).
  await expect(answer.getByText(/Listening… just speak your answer|Sending in \d s…/)).toBeVisible({
    timeout: 60_000,
  });

  // The fake microphone's tone is heard and transcribed as it plays.
  await expect(answer.getByText(/\[mock\] Spoken answer/).first()).toBeVisible({ timeout: 30_000 });

  // ---- Send it (the grace window may already be counting down) ----
  const sendNow = answer.getByRole('button', { name: 'Send now' });
  if (await sendNow.isEnabled().catch(() => false)) await sendNow.click();

  // The transcript became the first answer, and the next question arrives.
  await expect(page.getByRole('button', { name: 'Transcript (1 question)' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('#room-question-text')).toBeVisible({ timeout: 60_000 });
  // Push-to-talk stays available as a choice.
  await expect(answer.getByRole('button', { name: 'Use the record button instead' })).toBeVisible();
});
