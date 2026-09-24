import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANON_ID_KEY,
  createTracker,
  fetchSender,
  routePattern,
  sanitizePath,
  sanitizeProps,
  type AnalyticsSender,
  type TrackEventsPayload,
} from './analytics';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

function recorder() {
  const batches: { body: TrackEventsPayload; keepalive: boolean }[] = [];
  const send: AnalyticsSender = vi.fn(async (body, { keepalive }) => {
    batches.push({ body, keepalive });
  });
  return { send, batches };
}

describe('analytics tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues events and sends them together after the flush interval', () => {
    const { send, batches } = recorder();
    const storage = memoryStorage();
    const tracker = createTracker({ send, storage, flushIntervalMs: 5_000 });

    tracker.setPath('/app/reports/:id');
    tracker.track('report_viewed');
    tracker.track('report_pdf_downloaded', { source: 'report' });
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(batches).toHaveLength(1);
    const { body, keepalive } = batches[0]!;
    expect(keepalive).toBe(false);
    expect(body.anonId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(body.anonId).toBe(storage.data.get(ANON_ID_KEY));
    expect(body.events.map((e) => [e.name, e.path])).toEqual([
      ['report_viewed', '/app/reports/:id'],
      ['report_pdf_downloaded', '/app/reports/:id'],
    ]);
    expect(body.events[1]!.props).toEqual({ source: 'report' });
    expect(body.events[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    tracker.dispose();
  });

  it('keeps the same anonymous id across page loads', () => {
    const storage = memoryStorage({ [ANON_ID_KEY]: 'existing_anon_id_123' });
    const tracker = createTracker({ send: recorder().send, storage });
    expect(tracker.anonId).toBe('existing_anon_id_123');
    tracker.dispose();
  });

  it('sends at once when 25 events are waiting, in batches of at most 25', () => {
    const { send, batches } = recorder();
    const tracker = createTracker({ send, storage: memoryStorage(), flushIntervalMs: 5_000 });

    for (let i = 0; i < 30; i += 1) tracker.track('page_view');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.body.events).toHaveLength(25);

    vi.advanceTimersByTime(5_000);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.body.events).toHaveLength(5);
    tracker.dispose();
  });

  it('flushes with keepalive when the page is hidden or closed', () => {
    const { send, batches } = recorder();
    const target = new EventTarget() as unknown as Window;
    let visibility: DocumentVisibilityState = 'visible';
    const tracker = createTracker({
      send,
      storage: memoryStorage(),
      target,
      visibility: () => visibility,
    });

    tracker.track('pricing_viewed');
    target.dispatchEvent(new Event('visibilitychange'));
    expect(batches).toHaveLength(0);

    visibility = 'hidden';
    target.dispatchEvent(new Event('visibilitychange'));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.keepalive).toBe(true);

    tracker.track('checkout_started', { planCode: 'STARTER' });
    target.dispatchEvent(new Event('pagehide'));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({ keepalive: true });
    expect(batches[1]!.body.events[0]!.name).toBe('checkout_started');

    // Nothing queued: nothing sent.
    target.dispatchEvent(new Event('pagehide'));
    expect(batches).toHaveLength(2);
    tracker.dispose();
  });

  it('honours Do Not Track: nothing is queued or sent', () => {
    const { send } = recorder();
    const target = new EventTarget() as unknown as Window;
    const tracker = createTracker({ send, storage: memoryStorage(), doNotTrack: true, target });

    tracker.track('page_view');
    tracker.track('landing_cta_clicked');
    tracker.flush();
    target.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('swallows failed and throwing sends and drops the batch', async () => {
    const rejecting = vi.fn(async () => {
      throw new Error('offline');
    });
    const tracker = createTracker({ send: rejecting, storage: memoryStorage() });
    tracker.track('page_view');
    expect(() => tracker.flush()).not.toThrow();
    await vi.runAllTimersAsync();
    expect(rejecting).toHaveBeenCalledTimes(1);

    // Never retried: the failed batch is gone.
    tracker.flush();
    expect(rejecting).toHaveBeenCalledTimes(1);
    tracker.dispose();

    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const other = createTracker({ send: throwing, storage: memoryStorage() });
    other.track('page_view');
    expect(() => other.flush()).not.toThrow();
    other.dispose();
  });

  it('still works when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    const { send, batches } = recorder();
    const tracker = createTracker({ send, storage: blocked });
    tracker.track('page_view');
    tracker.flush();
    expect(batches[0]!.body.anonId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    tracker.dispose();
  });

  it('never sends a path that is not a route pattern', () => {
    const { send, batches } = recorder();
    const tracker = createTracker({ send, storage: memoryStorage() });

    tracker.setPath('/app/reports/int1?tab=plan');
    tracker.track('page_view');
    tracker.setPath('/proof/abc@example.com');
    tracker.track('page_view');
    tracker.flush();
    expect(batches[0]!.body.events.map((e) => e.path)).toEqual([undefined, undefined]);
    tracker.dispose();
  });
});

describe('analytics helpers', () => {
  it('turns matched URLs into route patterns without ids or tokens', () => {
    expect(routePattern('/app/interviews/6650abc123/setup', { id: '6650abc123' })).toBe(
      '/app/interviews/:id/setup',
    );
    expect(routePattern('/proof/Zx9-secret_Token', { token: 'Zx9-secret_Token' })).toBe(
      '/proof/:token',
    );
    expect(routePattern('/app/checkout/STARTER', { planCode: 'STARTER' })).toBe(
      '/app/checkout/:planCode',
    );
    expect(routePattern('/campaign/a%20b', { token: 'a b' })).toBe('/campaign/:token');
    expect(routePattern('/', {})).toBe('/');
    expect(routePattern('/app', {})).toBe('/app');
    expect(routePattern('/some/unknown/page', { '*': 'some/unknown/page' })).toBe('/:splat');
  });

  it('accepts only route-pattern paths', () => {
    expect(sanitizePath('/app/reports/:id')).toBe('/app/reports/:id');
    expect(sanitizePath('/app/reports/1?x=1')).toBeNull();
    expect(sanitizePath('https://evil.test/')).toBeNull();
    expect(sanitizePath('/a b')).toBeNull();
    expect(sanitizePath(`/${'a'.repeat(250)}`)).toBeNull();
  });

  it('keeps at most 10 valid, primitive props and truncates long strings', () => {
    const props = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeProps(props)!)).toHaveLength(10);
    expect(
      sanitizeProps({
        ok: 'x'.repeat(200),
        Bad: 1,
        'bad-key': 2,
        nan: Number.NaN,
        obj: {} as unknown as string,
        flag: true,
        none: null,
      }),
    ).toEqual({ ok: 'x'.repeat(120), flag: true, none: null });
    expect(sanitizeProps({})).toBeUndefined();
  });

  it('posts batches with keepalive and the bearer token when signed in', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const send = fetchSender('http://api.test', () => 'tok', fetchImpl as unknown as typeof fetch);
    const body = { anonId: 'anon_12345', events: [{ name: 'page_view' as const, path: '/' }] };
    await send(body, { keepalive: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/analytics/events');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual(body);

    const anonymous = fetchSender('http://api.test', () => null, fetchImpl as never);
    await anonymous(body, { keepalive: false });
    const [, second] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((second.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
