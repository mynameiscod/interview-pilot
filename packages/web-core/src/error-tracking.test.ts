import { describe, expect, it, vi } from 'vitest';
import { browserErrorTrackingOptions, initBrowserErrorTracking } from './error-tracking';

const cfg = {
  dsn: 'https://public@glitchtip.example.com/4',
  environment: 'production',
  release: '3ec8c31',
  app: 'candidate',
};

describe('browser error tracking', () => {
  it('is off without a DSN and never loads the SDK', async () => {
    const load = vi.fn();
    expect(browserErrorTrackingOptions({ ...cfg, dsn: undefined })).toBeNull();
    await expect(initBrowserErrorTracking({ ...cfg, dsn: '' }, load)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('initializes with release, environment and PII scrubbing', async () => {
    const init = vi.fn();
    await expect(initBrowserErrorTracking(cfg, async () => ({ init }))).resolves.toBe(true);
    const options = init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: cfg.dsn,
      release: '3ec8c31',
      environment: 'production',
      initialScope: { tags: { app: 'candidate' } },
      dataCollection: { userInfo: false, urlQueryParams: false },
    });
    const event = options.beforeSend({
      message: 'sign-in failed for asha@example.com',
      request: { url: 'https://interview.codebegun.com/auth/verify?otp=123456' },
    });
    expect(event).toEqual({
      message: 'sign-in failed for [Filtered]',
      request: { url: 'https://interview.codebegun.com/auth/verify?otp=[Filtered]' },
    });
  });

  it('swallows SDK load failures (ad blockers)', async () => {
    await expect(
      initBrowserErrorTracking(cfg, () => Promise.reject(new Error('blocked'))),
    ).resolves.toBe(false);
  });
});
