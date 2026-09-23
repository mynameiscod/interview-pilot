import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

const emailSchema = z.email();

/** Lower-cases and trims. Returns null for anything that is not a valid address. */
export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  return emailSchema.safeParse(value).success ? value : null;
}

/**
 * Parses a phone number to E.164. Numbers without a country code are read as
 * `defaultCountry` (India at launch). Returns null for invalid numbers.
 */
export function normalizeMobile(input: string, defaultCountry: CountryCode = 'IN'): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** "asha.k@gmail.com" → "a***k@gmail.com" */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/** "+919876543210" → "+91 ******3210" */
export function maskMobile(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  const national = parsed?.nationalNumber ?? e164.replace(/^\+/, '');
  const prefix = parsed ? `+${parsed.countryCallingCode} ` : '';
  return `${prefix}${'*'.repeat(Math.max(0, national.length - 4))}${national.slice(-4)}`;
}
