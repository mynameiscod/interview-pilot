import { ApiClientError } from '@cbi/web-core';
import type { TFunction } from 'i18next';
import { consoleError } from '../ai/format';

export type Issue = { path: string; message: string };

/** Field-level problems from a VALIDATION_FAILED response (`details.issues`). */
export function validationIssues(err: unknown): Issue[] {
  if (!(err instanceof ApiClientError) || err.code !== 'VALIDATION_FAILED') return [];
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .filter(
      (i): i is Issue =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as Issue).path === 'string' &&
        typeof (i as Issue).message === 'string',
    )
    .map((i) => ({ path: i.path, message: i.message }));
}

/** Like the AI console errors, but also passes through library state conflicts. */
export function libraryError(t: TFunction, err: unknown): string {
  if (err instanceof ApiClientError && err.code === 'INVALID_STATE') return err.message;
  if (validationIssues(err).length > 0) return t('library.errors.validation');
  return consoleError(t, err);
}

/** `Senior Backend Engineer` becomes `senior-backend-engineer`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function formatDateTime(value: string | null, locale: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

/** Whole minutes; interview rounds are configured in minutes. */
export const minutes = (seconds: number) => Math.round(seconds / 60);

/** Comma-separated text to a trimmed, de-duplicated list. */
export function splitList(value: string): string[] {
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

/** Our own form messages are i18n keys; anything else came from the server verbatim. */
export const fieldError = (t: TFunction, message: string | undefined) =>
  message?.startsWith('library.') ? t(message) : message;
