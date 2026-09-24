import { API_V1_PREFIX, type ClientEvent, type ClientEventName } from '@cbi/shared-types';

/**
 * Product analytics (Phase 11): a small, privacy-first event tracker.
 *
 * - Only allow-listed event names, route PATTERNS (never real ids, tokens or
 *   query strings) and a few non-personal props are sent.
 * - Events are queued in memory and sent in batches (on a timer, when the
 *   batch is full, and when the page is hidden).
 * - Failures are dropped silently: analytics never blocks or breaks the UI.
 * - `navigator.doNotTrack === '1'` turns everything off.
 * - Nothing happens until `initAnalytics` is called (main.tsx), so tests and
 *   other entry points are no-ops unless they set up a tracker themselves.
 */

export type EventProps = Record<string, string | number | boolean | null>;

export interface TrackEventsPayload {
  anonId: string;
  events: ClientEvent[];
}

export type AnalyticsSender = (
  body: TrackEventsPayload,
  opts: { keepalive: boolean },
) => Promise<unknown>;

export interface TrackerOptions {
  send: AnalyticsSender;
  /** Where the random anonymous id is kept (localStorage in the browser). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** True when the browser asks not to be tracked: nothing is queued or sent. */
  doNotTrack?: boolean;
  /** How long an event may wait before its batch is sent. */
  flushIntervalMs?: number;
  /** Page lifecycle events (pagehide / visibilitychange) come from here. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  /** Reads `document.visibilityState`. */
  visibility?: () => DocumentVisibilityState;
  now?: () => Date;
}

export interface Tracker {
  readonly anonId: string;
  /** Sets the current route pattern attached to later events. */
  setPath(pattern: string | null): void;
  track(name: ClientEventName, props?: EventProps): void;
  flush(opts?: { keepalive?: boolean }): void;
  dispose(): void;
}

export const MAX_BATCH = 25;
/** Events waiting beyond this (e.g. while offline) are dropped, oldest first. */
const MAX_QUEUE = 100;
const DEFAULT_FLUSH_MS = 8_000;
export const ANON_ID_KEY = 'cbi.anonId';

const ANON_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PATH_RE = /^\/[A-Za-z0-9/:_-]*$/;
const PROP_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const MAX_PROPS = 10;
const MAX_PROP_STRING = 120;

/** A route pattern the API accepts, or null (so a bad path is left out, never sent). */
export function sanitizePath(path: string | null | undefined): string | null {
  if (!path || path.length > 200 || !PATH_RE.test(path)) return null;
  return path;
}

/** Keeps only props the API accepts: at most 10, valid keys, primitive values. */
export function sanitizeProps(props: EventProps | undefined): EventProps | undefined {
  if (!props) return undefined;
  const out: EventProps = {};
  let count = 0;
  for (const [key, value] of Object.entries(props)) {
    if (count >= MAX_PROPS) break;
    if (!PROP_KEY_RE.test(key)) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_PROP_STRING);
    else if (value === null || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
    else continue;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/**
 * Turns a matched URL back into its route pattern, e.g.
 * `/app/interviews/6650ab/setup` with `{ id: '6650ab' }` →
 * `/app/interviews/:id/setup`. A catch-all tail becomes `:splat`.
 */
export function routePattern(
  pathname: string,
  params: Readonly<Record<string, string | undefined>>,
): string | null {
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  let segments = pathname.split('/').filter(Boolean);
  let tail: string[] = [];
  const splat = params['*'];
  if (splat) {
    const count = splat.split('/').filter(Boolean).length;
    segments = segments.slice(0, Math.max(0, segments.length - count));
    tail = [':splat'];
  }
  const named = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[0] !== '*' && typeof entry[1] === 'string',
  );
  const pattern = segments.map((segment) => {
    const value = decode(segment);
    const param = named.find(([, v]) => v === value);
    return param ? `:${param[0]}` : segment;
  });
  return sanitizePath(`/${[...pattern, ...tail].join('/')}`);
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(bytes, (b) => alphabet[b % 64]).join('');
}

/** The browser's random anonymous id, created and remembered on first use. */
export function loadAnonId(storage: TrackerOptions['storage']): string {
  try {
    const existing = storage?.getItem(ANON_ID_KEY);
    if (existing && ANON_ID_RE.test(existing)) return existing;
  } catch {
    // Storage blocked (private mode, site data off): use an id for this page only.
  }
  const id = randomId();
  try {
    storage?.setItem(ANON_ID_KEY, id);
  } catch {
    // Ignore; the id still works for this page.
  }
  return id;
}

export function createTracker(opts: TrackerOptions): Tracker {
  const anonId = loadAnonId(opts.storage);
  const flushMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const now = opts.now ?? (() => new Date());
  const target = opts.target ?? null;
  const visibility = opts.visibility ?? (() => document.visibilityState);
  let queue: ClientEvent[] = [];
  let path: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function flush({ keepalive = false }: { keepalive?: boolean } = {}) {
    clearTimer();
    while (queue.length > 0) {
      const events = queue.slice(0, MAX_BATCH);
      queue = queue.slice(MAX_BATCH);
      try {
        // Fire and forget: a failed batch is dropped, never retried.
        void Promise.resolve(opts.send({ anonId, events }, { keepalive })).catch(() => undefined);
      } catch {
        // A sender that throws synchronously is treated like a failed request.
      }
    }
  }

  const onPageHide = () => flush({ keepalive: true });
  const onVisibility = () => {
    if (visibility() === 'hidden') flush({ keepalive: true });
  };

  if (!opts.doNotTrack) {
    target?.addEventListener('pagehide', onPageHide);
    target?.addEventListener('visibilitychange', onVisibility);
  }

  return {
    anonId,
    setPath(pattern) {
      path = sanitizePath(pattern);
    },
    track(name, props) {
      if (opts.doNotTrack || disposed) return;
      const event: ClientEvent = { name, at: now().toISOString() };
      if (path) event.path = path;
      const clean = sanitizeProps(props);
      if (clean) event.props = clean;
      queue.push(event);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      if (queue.length >= MAX_BATCH) flush();
      else if (timer === null) timer = setTimeout(() => flush(), flushMs);
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      queue = [];
      target?.removeEventListener('pagehide', onPageHide);
      target?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * Sends a batch straight with `fetch` so it can use `keepalive` (the request
 * survives the page being closed). The bearer token links the events to the
 * signed-in user; without one they stay anonymous.
 */
export function fetchSender(
  baseUrl: string,
  getToken: () => string | null | undefined,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): AnalyticsSender {
  return async (body, { keepalive }) => {
    const token = getToken();
    const response = await fetchImpl(`${baseUrl}${API_V1_PREFIX}/analytics/events`, {
      method: 'POST',
      keepalive,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`analytics ${response.status}`);
  };
}

/** Browser storage, or null when the page may not use it. */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const browserDoNotTrack = () =>
  typeof navigator !== 'undefined' && navigator.doNotTrack === '1';

// ---- The app-wide tracker -----------------------------------------------------------------------

let active: Tracker | null = null;

/** Starts the app's tracker (once). Until then `track` does nothing. */
export function initAnalytics(opts: TrackerOptions): Tracker {
  active ??= createTracker(opts);
  return active;
}

/** Stops and forgets the app's tracker (tests). */
export function resetAnalytics() {
  active?.dispose();
  active = null;
}

export function track(name: ClientEventName, props?: EventProps) {
  try {
    active?.track(name, props);
  } catch {
    // Never let analytics break the page.
  }
}

export function setAnalyticsPath(pattern: string | null) {
  active?.setPath(pattern);
}
