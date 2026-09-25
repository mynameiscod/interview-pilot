import { ApiClientError } from '@cbi/web-core';
import type { TFunction } from 'i18next';
import type { Issue } from '../library/format';

/** Seconds since something happened, as a short "… ago". */
export function formatAge(t: TFunction, seconds: number): string {
  if (seconds < 60) return t('system.age.seconds', { count: Math.max(0, Math.round(seconds)) });
  if (seconds < 3600) return t('system.age.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('system.age.hours', { count: Math.floor(seconds / 3600) });
  return t('system.age.days', { count: Math.floor(seconds / 86_400) });
}

/** A readable queue name when we know it; the raw name stays visible beside it. */
export function queueLabel(t: TFunction, name: string): string {
  return t(`system.queueNames.${name.replace(/[.:]/g, '_')}`, { defaultValue: '' });
}

/** Problems from a VALIDATION_FAILED reply: `details` is the issue list or `{ issues }`. */
export function serverIssues(err: unknown): Issue[] {
  if (!(err instanceof ApiClientError) || err.code !== 'VALIDATION_FAILED') return [];
  const details = err.details as unknown;
  const list = Array.isArray(details)
    ? details
    : (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const i = raw as { path?: unknown; message?: unknown };
    if (typeof i?.message !== 'string') return [];
    const path = Array.isArray(i.path)
      ? i.path.join('.')
      : typeof i.path === 'string'
        ? i.path
        : '';
    return [{ path, message: i.message }];
  });
}
