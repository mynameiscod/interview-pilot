import type { AdminMediaAsset } from '@cbi/shared-types';
import type { TFunction } from 'i18next';
import { config } from '../../config';

/** Storage sizes in binary units (`1.5 MB`). */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Seconds from the interview start as `00:02:10`. */
export function formatOffset(offsetSec: number): string {
  const total = Math.max(0, Math.floor(offsetSec));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** A short duration from milliseconds (`45 s`, `2 min 5 s`). */
export function formatDuration(t: TFunction, ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('privacy.duration.seconds', { count: seconds });
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return sec === 0
    ? t('privacy.duration.minutes', { count: min })
    : t('privacy.duration.minutesSeconds', { min, sec });
}

/**
 * Playback links are paths on the API origin (signed, no auth header), so
 * the `<video>` element needs the API base URL in front of them.
 */
export function playbackSrc(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.apiUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** `58 of 60`, or just the count while the expected total is unknown. */
export function segmentsLabel(
  t: TFunction,
  asset: Pick<AdminMediaAsset, 'segmentCount' | 'expectedSegments'>,
): string {
  return asset.expectedSegments === null
    ? t('privacy.segments.received', { count: asset.segmentCount })
    : t('privacy.segments.ofExpected', {
        received: asset.segmentCount,
        expected: asset.expectedSegments,
      });
}
