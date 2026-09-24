import type { ConfidenceLevel, ReportDimension } from '@cbi/shared-types';
import type { TFunction } from 'i18next';

export const CONFIDENCE_ICON: Record<ConfidenceLevel, string> = {
  HIGH: 'bi-shield-fill-check',
  MEDIUM: 'bi-shield-fill-exclamation',
  LOW: 'bi-shield-fill-x',
};

/** Evidence strength (-2..+2) as a translation key; never shown as colour alone. */
export function strengthKey(strength: number): string {
  if (strength >= 2) return 'strong';
  if (strength === 1) return 'some';
  if (strength === 0) return 'mixed';
  if (strength === -1) return 'weak';
  return 'contrary';
}

export const STRENGTH_ICON: Record<string, string> = {
  strong: 'bi-check-circle-fill text-success',
  some: 'bi-check-circle text-success',
  mixed: 'bi-dash-circle cb-text-secondary',
  weak: 'bi-exclamation-circle text-warning',
  contrary: 'bi-x-circle text-danger',
};

/** Highest score first; unscored dimensions last, heavier ones first within each group. */
export function sortDimensions(dimensions: readonly ReportDimension[]): ReportDimension[] {
  return [...dimensions].sort((a, b) => {
    if (a.score === null && b.score === null) return b.weight - a.weight;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || b.weight - a.weight;
  });
}

/** "+8", "−3" or "0" (a real minus sign, so screen readers say "minus"). */
export function signed(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

/** A change in points with its direction in words, e.g. "+8 (improved)". */
export function deltaText(t: TFunction, delta: number): string {
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
  return t(`report.delta.${direction}`, { value: signed(delta) });
}

export const DELTA_ICON = (delta: number) =>
  delta > 0 ? 'bi-arrow-up-right' : delta < 0 ? 'bi-arrow-down-right' : 'bi-arrow-right';

export const percent = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100);

export function scoreText(t: TFunction, score: number | null): string {
  return score === null ? t('report.notAssessed') : t('report.scoreOutOf', { score });
}
