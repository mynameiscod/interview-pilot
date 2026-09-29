import { describe, expect, it } from 'vitest';
import {
  AnalyticsEventName,
  ClientEventName,
  ServerEventName,
  TrackEventsBody,
} from './analytics.js';

describe('analytics event names', () => {
  it('does not let clients send server-recorded events', () => {
    expect(ClientEventName.options).not.toContain('report_viewed');
    expect(
      TrackEventsBody.safeParse({ anonId: 'anon_12345678', events: [{ name: 'report_viewed' }] })
        .success,
    ).toBe(false);
    expect(
      TrackEventsBody.safeParse({ anonId: 'anon_12345678', events: [{ name: 'compare_viewed' }] })
        .success,
    ).toBe(true);
  });

  it('stores client and server events, with no name in both lists', () => {
    expect(AnalyticsEventName.options).toEqual([
      ...ClientEventName.options,
      ...ServerEventName.options,
    ]);
    const client = new Set<string>(ClientEventName.options);
    expect(ServerEventName.options.filter((n) => client.has(n))).toEqual([]);
  });
});
