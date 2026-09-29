import { describe, expect, it } from 'vitest';
import { disabledErrorTracker, initErrorTracking, sentryNodeOptions } from './error-tracking.js';

const opts = {
  dsn: 'https://public@glitchtip.example.com/3',
  service: 'api',
  environment: 'staging',
  release: '3ec8c31',
};

describe('initErrorTracking', () => {
  it('is a no-op without a DSN', async () => {
    const tracker = initErrorTracking({ ...opts, dsn: undefined });
    expect(tracker).toBe(disabledErrorTracker);
    expect(tracker.enabled).toBe(false);
    expect(() => tracker.captureException(new Error('x'))).not.toThrow();
    await expect(tracker.flush()).resolves.toBe(true);
  });
});

describe('sentryNodeOptions', () => {
  it('collects no PII and tags release, environment and service', () => {
    const o = sentryNodeOptions(opts);
    expect(o.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpBodies: [] });
    expect(o.release).toBe('3ec8c31');
    expect(o.environment).toBe('staging');
    expect(o.initialScope).toEqual({ tags: { service: 'api' } });
    expect(o.tracesSampleRate).toBeUndefined();
  });

  it('scrubs events before they are sent', () => {
    const o = sentryNodeOptions(opts);
    const event = o.beforeSend!(
      {
        type: undefined,
        message: 'otp to asha@example.com failed',
        user: { id: 'u1', email: 'asha@example.com' },
        request: { headers: { authorization: 'Bearer abc' }, cookies: { rt: 'x' } },
      },
      {},
    ) as unknown as { message: string; user: unknown; request: unknown };
    expect(event.message).toBe('otp to [Filtered] failed');
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.request).toEqual({ headers: { authorization: '[Filtered]' } });
  });

  it('drops integrations that capture on their own or collect request data', () => {
    const o = sentryNodeOptions(opts);
    const names = ['Http', 'OnUnhandledRejection', 'OnUncaughtException', 'LocalVariables'];
    const kept = (o.integrations as (d: { name: string }[]) => { name: string }[])(
      names.map((name) => ({ name })),
    ).map((i) => i.name);
    expect(kept).toEqual(['Http', 'OnUncaughtException']);
  });
});
