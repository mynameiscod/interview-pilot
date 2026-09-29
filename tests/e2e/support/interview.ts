import { expect, type Page } from '@playwright/test';
import { WORKER_STEP_TIMEOUT } from './env';

const ANSWERS = [
  'I designed an idempotent payments API in Node.js: every request carries an idempotency key stored with a unique index, so retries never double-charge.',
  'For a slow MongoDB query I read the explain plan, added a compound index that matched the filter and sort, and cut p95 latency from 800 ms to 90 ms.',
  'When an outage hit, I rolled back first, then wrote a blameless post-mortem and added an alert on queue depth so we would catch it earlier next time.',
];

export type InterviewMode = 'Text' | 'Voice' | 'Video';

/**
 * From the candidate dashboard: a role-only interview (library role, no
 * resume or JD) through the wizard, role analysis (worker) and setup in
 * `mode`, ending on the step after "Your interview is ready" (consents or
 * the start screen for text; the device check for voice and video).
 */
export async function setUpRoleOnlyInterview(page: Page, mode: InterviewMode) {
  // ---- New interview wizard: no resume, no JD, a library role ----
  await page.getByRole('link', { name: 'Start an interview' }).click();
  await expect(page.getByRole('heading', { name: 'New interview', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: "Let's begin" }).click();
  await expect(page.getByRole('heading', { name: 'Add your resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue without a resume' }).click();
  await expect(page.getByRole('heading', { name: 'Add the job description' })).toBeVisible();
  await page.getByRole('button', { name: "Skip — I don't have one" }).click();
  await expect(page.getByRole('heading', { name: 'Company and role' })).toBeVisible();

  const role = page.getByRole('combobox', { name: /^Role/ });
  await role.fill('Backend');
  await page.getByRole('option', { name: 'Backend Engineer', exact: true }).click();
  await expect(page.getByText('Selected from our list.')).toBeVisible();
  await page.getByRole('button', { name: 'Analyse my interview' }).click();

  // ---- Role analysis runs in the worker ----
  await expect(page).toHaveURL(/\/app\/interviews\/[^/]+\/analysis$/);
  const looksRight = page.getByRole('link', { name: 'Looks right — continue' });
  await expect(looksRight).toBeVisible({ timeout: WORKER_STEP_TIMEOUT });
  await expect(page.getByRole('heading', { name: 'Your interview plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Skills we will focus on' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Planned rounds' })).toBeVisible();
  await looksRight.click();

  // ---- Setup: the mode ----
  await expect(page.getByRole('heading', { name: 'Set up your interview' })).toBeVisible();
  await page.getByRole('radio', { name: mode, exact: true }).check();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your interview is ready' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue', exact: true }).click();
}

/**
 * From the candidate dashboard: a role-only text interview (library role, no
 * resume or JD) through analysis, setup, consents and the room (three answers,
 * then end early), up to the report page. Worker steps wait generously.
 */
export async function runRoleOnlyTextInterview(page: Page) {
  await setUpRoleOnlyInterview(page, 'Text');

  // ---- Consents (if this interview asks for any), then start ----
  await expect(
    page.getByRole('heading', { name: /^(Ready to begin\?|Before you start)$/, level: 1 }),
  ).toBeVisible();
  if (/\/consent$/.test(page.url())) {
    await expect(
      page.getByRole('heading', { name: 'Your choices for this interview' }),
    ).toBeVisible();
    for (const agree of await page.getByRole('radio', { name: 'I agree' }).all()) {
      await agree.check();
    }
    await page.getByRole('button', { name: 'Save my choices' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Ready to begin?' })).toBeVisible();
  await expect(page.getByText(/You have \d+ credits? available\./)).toBeVisible();
  await page.getByRole('button', { name: 'Start interview' }).click();

  // ---- Text interview room: three answers, then end early ----
  await expect(page).toHaveURL(/\/room$/);
  const answer = page.getByRole('textbox', { name: 'Your answer' });
  for (const [i, text] of ANSWERS.entries()) {
    await expect(page.locator('#room-question-text')).toBeVisible({ timeout: 60_000 });
    await expect(answer).toBeEditable({ timeout: 60_000 });
    await answer.fill(text);
    await page.getByRole('button', { name: 'Send answer' }).click();
    const n = i + 1;
    await expect(
      page.getByRole('button', { name: `Transcript (${n} question${n === 1 ? '' : 's'})` }),
    ).toBeVisible({ timeout: 60_000 });
  }
  await page.getByRole('button', { name: 'End interview' }).click();
  await expect(page.getByRole('heading', { name: 'End now?' })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, end the interview' }).click();

  // ---- Completion: evaluation runs in the worker ----
  await expect(page).toHaveURL(/\/complete$/, { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Thank you for completing your interview' }),
  ).toBeVisible();
  const viewReport = page.getByRole('link', { name: 'View your report' });
  await expect(viewReport).toBeVisible({ timeout: WORKER_STEP_TIMEOUT });
  await viewReport.click();

  await expect(page).toHaveURL(/\/app\/reports\/[^/]+$/);
}

/**
 * The device check of a voice or video interview, with Chromium's fake
 * camera and microphone (`--use-fake-device-for-media-stream`): camera
 * (video), microphone level, the test sound (answered "yes"), then save.
 * Ends on the consent step.
 */
export async function passDeviceCheck(page: Page, mode: 'Voice' | 'Video') {
  await expect(page).toHaveURL(/\/device-check$/);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name:
        mode === 'Video'
          ? 'Check your camera, microphone and speaker'
          : 'Check your microphone and speaker',
    }),
  ).toBeVisible();
  if (mode === 'Video') {
    await page.getByRole('button', { name: 'Test camera' }).click();
    await expect(page.getByText('Your camera works.')).toBeVisible();
    await expect(page.getByLabel('Your camera preview')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Test microphone' }).click();
  // The fake microphone plays a periodic tone; the check listens for a few seconds.
  await expect(page.getByText('We can hear you clearly.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Play test sound' }).click();
  await expect(page.getByText('Did you hear it?')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, I heard it' }).click();
  await expect(page.getByText(/Your connection is good/)).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your choices for this interview' }),
  ).toBeVisible();
}

/** Agrees to every notice on the consent step (recording included), then continues to start. */
export async function acceptAllConsents(page: Page) {
  const recording = page.getByRole('group', { name: /Recording/ });
  if (await recording.count()) {
    await recording.getByRole('radio', { name: 'Record this interview' }).check();
  }
  for (const agree of await page.getByRole('radio', { name: 'I agree' }).all()) {
    await agree.check();
  }
  await page.getByRole('button', { name: 'Save my choices' }).click();
  await expect(page.getByRole('heading', { name: 'You are ready' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready to begin?' })).toBeVisible();
}
