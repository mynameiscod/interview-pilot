import { formatMoney } from '../payments/format';

/** Analytics ranges are calendar days in India time. */
const INDIA_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const MAX_RANGE_DAYS = 366;
export const PRESETS = [7, 30, 90] as const;
export const DEFAULT_PRESET = 30;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in India (`YYYY-MM-DD`). */
export function indiaToday(now = new Date()): string {
  return INDIA_DAY.format(now);
}

export function isDay(value: string | null | undefined): value is string {
  if (!value || !DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days from `from` to `to`. */
export function daysInRange(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export type DayRange = { from: string; to: string };

/** The last `days` days, ending today (India time). */
export function presetRange(days: number, now = new Date()): DayRange {
  const to = indiaToday(now);
  return { from: addDays(to, -(days - 1)), to };
}

/** Why a typed range is unusable, as an i18n key (null when it is fine). */
export function rangeProblem(range: DayRange): string | null {
  if (!isDay(range.from) || !isDay(range.to)) return 'analytics.range.errors.invalid';
  if (range.from > range.to) return 'analytics.range.errors.order';
  if (daysInRange(range.from, range.to) > MAX_RANGE_DAYS) return 'analytics.range.errors.tooLong';
  return null;
}

/** INR paise as rupees with two decimals (₹1,499.00). */
export const formatPaise = (minor: number) => formatMoney(minor, 'INR');

/** A 0–1 fraction as a percentage; null (no data) is a dash. */
export function formatRate(rate: number | null, locale: string, digits = 1): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(rate);
}

/** A 0–1 fraction as the number an admin types in a percent field (`0.055` becomes `5.5`). */
export const rateToPercentInput = (rate: number) => String(Number((rate * 100).toFixed(4)));

/** A typed percent back to a 0–1 fraction; anything non-numeric is NaN so validation fails. */
export function percentInputToRate(value: string): number {
  const trimmed = value.trim().replace(/%$/, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return Number.NaN;
  return Number((Number(trimmed) / 100).toFixed(6));
}

/** A `YYYY-MM-DD` day as a short date (`24 Sept`); the day itself has no time zone. */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
