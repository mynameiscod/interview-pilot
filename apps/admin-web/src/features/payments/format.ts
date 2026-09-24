import { ApiClientError } from '@cbi/web-core';
import type { TFunction } from 'i18next';
import type { z } from 'zod';
import { consoleError } from '../ai/format';

/** Money arrives as integer minor units (paise); shown in Indian grouping. */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}

/**
 * A rupee amount typed by an admin (`1499`, `1,499.50`) to integer paise.
 * Anything else, including more than two decimals, is NaN so validation fails.
 */
export function rupeesToPaise(value: string): number {
  const cleaned = value.replace(/[\s,₹]/g, '');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Paise back to the decimal string the forms accept (`149950` becomes `1499.50`). */
export function paiseToRupees(minor: number): string {
  const rupees = Math.floor(minor / 100);
  const paise = minor % 100;
  return paise === 0 ? String(rupees) : `${rupees}.${String(paise).padStart(2, '0')}`;
}

/** An optional whole-number field: empty is null, anything non-integer is NaN. */
export function optionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export const requiredInt = (value: string): number => optionalInt(value) ?? Number.NaN;

/** `<input type="datetime-local">` value (local time) for an ISO timestamp. */
export function isoToLocalInput(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The first field each shared-schema issue belongs to, named by `fieldFor`
 * (unknown paths are dropped). Messages are our own i18n keys per field.
 */
export function issueFields<F extends string>(
  error: z.ZodError,
  fieldFor: (path: string) => F | null,
): F[] {
  const fields = new Set<F>();
  for (const issue of error.issues) {
    const field = fieldFor(issue.path.join('.'));
    if (field) fields.add(field);
  }
  return [...fields];
}

/** Refund/reconcile conflicts carry a specific server message; provider outages get ours. */
export function paymentsError(t: TFunction, err: unknown): string {
  if (err instanceof ApiClientError && err.code === 'INVALID_STATE') return err.message;
  if (err instanceof ApiClientError && err.code === 'PROVIDER_UNAVAILABLE') {
    return t('payments.errors.providerUnavailable');
  }
  return consoleError(t, err);
}
