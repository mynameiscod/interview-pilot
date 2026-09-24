import type { ClientEventName } from '@cbi/shared-types';
import { useEffect, useRef } from 'react';
import { useLocation, useMatches } from 'react-router';
import { routePattern, setAnalyticsPath, track, type EventProps } from './analytics';

/**
 * Tracks `name` once per mounted component, as soon as `when` is true
 * (e.g. once the data a page shows has loaded).
 */
export function useTrackOnce(name: ClientEventName, when = true, props?: EventProps) {
  const sent = useRef(false);
  useEffect(() => {
    if (!when || sent.current) return;
    sent.current = true;
    track(name, props);
  }, [name, when, props]);
}

/**
 * Sends `page_view` on every navigation with the matched route PATTERN
 * (`/app/reports/:id`), never the real URL. Rendered once per layout.
 */
export function RouteAnalytics() {
  const matches = useMatches();
  const location = useLocation();
  const last = matches[matches.length - 1];
  const pattern = last ? routePattern(last.pathname, last.params) : null;
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastKey.current === location.key) return;
    lastKey.current = location.key;
    setAnalyticsPath(pattern);
    track('page_view');
  }, [location.key, pattern]);

  return null;
}
