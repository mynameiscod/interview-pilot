import { API_V1_PREFIX, type SessionAudience } from '@cbi/shared-types';
import type { Request, Response } from 'express';

export interface CookieSettings {
  /** True outside development/test: cookies are only sent over HTTPS. */
  secure: boolean;
  domain?: string;
}

/**
 * Refresh tokens live in httpOnly cookies scoped to the auth endpoints of
 * their own app, so they are never readable by JavaScript and never sent with
 * ordinary API calls. `__Secure-` prefix enforces the Secure attribute.
 */
const COOKIE_BASE: Record<SessionAudience, string> = {
  candidate: 'cbi_rt',
  admin: 'cbi_admin_rt',
  org: 'cbi_org_rt',
};

/** The auth endpoints of each app (also the refresh cookie's path). */
export const AUTH_PATH: Record<SessionAudience, string> = {
  candidate: '/auth',
  admin: '/admin/auth',
  org: '/org/auth',
};

function cookieSpec(audience: SessionAudience, settings: CookieSettings) {
  const base = COOKIE_BASE[audience];
  return {
    name: settings.secure ? `__Secure-${base}` : base,
    path: `${API_V1_PREFIX}${AUTH_PATH[audience]}`,
  };
}

export function setRefreshCookie(
  res: Response,
  audience: SessionAudience,
  settings: CookieSettings,
  token: string,
  expiresAt: Date,
) {
  const { name, path } = cookieSpec(audience, settings);
  res.cookie(name, token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path,
    domain: settings.domain,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(
  res: Response,
  audience: SessionAudience,
  settings: CookieSettings,
) {
  const { name, path } = cookieSpec(audience, settings);
  res.clearCookie(name, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    path,
    domain: settings.domain,
  });
}

export function readRefreshCookie(
  req: Request,
  audience: SessionAudience,
  settings: CookieSettings,
): string | null {
  const { name } = cookieSpec(audience, settings);
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
    }
  }
  return null;
}
