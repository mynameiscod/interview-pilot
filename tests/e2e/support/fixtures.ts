import { existsSync } from 'node:fs';
import {
  test as base,
  expect,
  webkit,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { clearRateLimits, createAdmin, type AdminRole } from './data';
import { URLS } from './env';

const webkitInstalled = (() => {
  try {
    return existsSync(webkit.executablePath());
  } catch {
    return false;
  }
})();

export const test = base.extend<{ _suiteGuards: void }>({
  _suiteGuards: [
    async ({ browserName }, use, testInfo) => {
      // WebKit runs in CI; on a machine without it, skip instead of failing.
      testInfo.skip(
        browserName === 'webkit' && !webkitInstalled,
        'WebKit is not installed (run `corepack pnpm e2e:install`).',
      );
      await clearRateLimits();
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** A unique address per test and project, so specs never share users. */
export function uniqueEmail(prefix: string, domain = 'example.com') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}@${domain}`.toLowerCase();
}

interface MailpitSummary {
  ID: string;
  Created: string;
}

/** Reads the newest 6-digit code sent to `email` at or after `since` from Mailpit. */
export async function readOtp(email: string, since: Date): Promise<string> {
  let code: string | null = null;
  await expect
    .poll(
      async () => {
        const query = encodeURIComponent(`to:"${email}"`);
        const res = await fetch(`${URLS.mailpit}/api/v1/search?query=${query}&limit=5`);
        if (!res.ok) return null;
        const list = (await res.json()) as { messages?: MailpitSummary[] };
        const newest = (list.messages ?? [])
          .filter((m) => new Date(m.Created).getTime() >= since.getTime() - 2_000)
          .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime())[0];
        if (!newest) return null;
        const msg = (await (await fetch(`${URLS.mailpit}/api/v1/message/${newest.ID}`)).json()) as {
          Text?: string;
        };
        code = /\b(\d{6})\b/.exec(msg.Text ?? '')?.[1] ?? null;
        return code;
      },
      { message: `OTP email for ${email}`, timeout: 30_000, intervals: [500] },
    )
    .not.toBeNull();
  return code!;
}

/**
 * Completes the email OTP form on the current page (candidate or admin
 * sign-in; the labels differ slightly between the apps).
 */
export async function completeOtpSignIn(page: Page, email: string) {
  const since = new Date();
  await page.getByLabel(/^(Email address|Work email)$/).fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  const code = await readOtp(email, since);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: /^Verify and (continue|sign in)$/ }).click();
}

/** Fills the onboarding form (only the name is required). */
export async function completeOnboarding(page: Page, name: string) {
  await expect(page.getByRole('heading', { name: 'Tell us a little about you' })).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** New candidate: sign in with an email OTP, onboard, and land on the dashboard. */
export async function signUpCandidate(page: Page, opts: { email?: string; name?: string } = {}) {
  const email = opts.email ?? uniqueEmail('cand');
  const name = opts.name ?? 'Asha E2E';
  await page.goto(`${URLS.candidate}/login`);
  await completeOtpSignIn(page, email);
  await completeOnboarding(page, name);
  await expect(page.getByRole('heading', { name: `Hi ${name}` })).toBeVisible();
  return { email, name };
}

/** Creates an admin with the given roles and signs in to the admin console. */
export async function signInAdmin(page: Page, roles: AdminRole[]) {
  const email = uniqueEmail(roles[0]!.toLowerCase().replace('_admin', ''), 'codebegun.com');
  await createAdmin(email, roles);
  await page.goto(`${URLS.admin}/login`);
  await expect(page.getByRole('heading', { name: 'Sign in to the admin console' })).toBeVisible();
  // The admin login opens on the password form; these admins have no password.
  await page.getByRole('button', { name: 'Email code' }).click();
  await completeOtpSignIn(page, email);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return { email };
}

/** The admin navigation collapses behind a toggle below the lg breakpoint. */
export async function adminNav(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  const toggle = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await expect(nav).toBeVisible();
  return nav;
}

/**
 * A second, isolated browser context with the current project's device
 * settings (viewport, touch, user agent), e.g. for a candidate alongside an admin.
 */
export async function newDeviceContext(browser: Browser, testInfo: TestInfo) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId } =
    testInfo.project.use;
  return browser.newContext({
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    locale,
    timezoneId,
  });
}
