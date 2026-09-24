import type { TFunction } from 'i18next';

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
