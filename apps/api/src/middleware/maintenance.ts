import type { AccessTokenIssuer } from '@cbi/auth-core';
import type { MaintenanceSetting } from '@cbi/shared-types';
import type { Request, RequestHandler } from 'express';
import { maintenanceError } from '../lib/maintenance.js';
import type { UserStateCache } from '../modules/auth/user-state.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Seconds a client is asked to wait before retrying a refused write. */
export const MAINTENANCE_RETRY_AFTER_SEC = 120;

/** A slow settings read must not stall every write; past this the request goes through. */
const SETTING_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`maintenance setting read timed out after ${ms} ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Writes that stay open during maintenance, as paths under `/api/v1`:
 * - `/auth/**`: signing in and out, OTP, refresh and identity linking, so
 *   nobody is locked out of reading their reports;
 * - `/admin/**`: admins run the maintenance;
 * - `/org/**`: organisations keep managing campaigns and candidates (joins stay closed);
 * - payment webhooks and verification: the money has already moved, the
 *   purchase must be recorded (the mock checkout is the dev equivalent);
 * - analytics events: telemetry, not a state change;
 * - unsubscribing from emails: opting out must always work;
 * - an interview that is already running: ending it, switching mode,
 *   transcribing, coding and design answers and recording segments
 *   (maintenance stops new interviews only; creating, setting up and
 *   starting one is refused).
 */
export const MAINTENANCE_EXEMPT_PATHS: readonly RegExp[] = [
  /^\/auth\//,
  /^\/admin(\/|$)/,
  /^\/org(\/|$)/,
  /^\/payments\/(webhooks\/|verify$|mock\/)/,
  /^\/analytics\/events$/,
  /^\/email\/unsubscribe$/,
  /^\/interviews\/[^/]+\/(end|mode|voice\/transcribe|coding\/.+|design\/.+|media\/segments\/[^/]+|media\/finalize)$/,
];

/** Whether maintenance mode refuses this request (a candidate write outside the exemptions). */
export function blockedDuringMaintenance(method: string, path: string): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  return !MAINTENANCE_EXEMPT_PATHS.some((re) => re.test(path));
}

/** Whether the bearer token belongs to a current admin (either audience). */
async function isAdmin(
  req: Request,
  deps: { tokens: AccessTokenIssuer; userState: UserStateCache },
): Promise<boolean> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  for (const audience of ['admin', 'candidate'] as const) {
    try {
      const claims = await deps.tokens.verify(token, audience);
      const state = await deps.userState.get(claims.userId);
      return Boolean(
        state &&
        state.status === 'ACTIVE' &&
        state.tokenVersion === claims.tokenVersion &&
        state.adminRoles.length > 0,
      );
    } catch {
      // Not a token for this audience; try the next.
    }
  }
  return false;
}

/**
 * Maintenance mode for the whole candidate API: while it is on, writes are
 * refused with 503 MAINTENANCE (reads keep working, so reports stay
 * visible). Mount on the `/api/v1` router. The setting is read through the
 * settings cache, which admin changes invalidate on every process. If the
 * setting cannot be read the request goes through: maintenance must never
 * be the cause of an outage.
 */
export function maintenanceGuard(deps: {
  maintenance: () => Promise<MaintenanceSetting>;
  tokens: AccessTokenIssuer;
  userState: UserStateCache;
}): RequestHandler {
  return async (req, res, next) => {
    if (!blockedDuringMaintenance(req.method, req.path)) return next();
    // Without a bearer token the route refuses the write anyway (401), so there
    // is nothing to protect and no reason to read the setting.
    if (!req.headers.authorization?.startsWith('Bearer ')) return next();
    let m: MaintenanceSetting;
    try {
      m = await withTimeout(deps.maintenance(), SETTING_TIMEOUT_MS);
    } catch (err) {
      req.log?.warn({ err }, 'maintenance setting unavailable; request allowed');
      return next();
    }
    if (!m.enabled || (await isAdmin(req, deps))) return next();
    res.set('Retry-After', String(MAINTENANCE_RETRY_AFTER_SEC));
    next(maintenanceError(m));
  };
}
