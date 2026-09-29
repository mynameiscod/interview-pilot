import { InviteInput, MAX_INVITES_PER_REQUEST, type InvitePreview } from './org.js';

/**
 * Bulk invite CSV: a header row, then one invite per line. `email` is
 * required; `name`, `language` (en, hi, te), `batch`, `branch` and `year`
 * are optional. Column order is free and header names are case-insensitive.
 * Used by the API's validation preview (and its unit tests); nothing is
 * saved until the organisation confirms the valid rows.
 */

export const INVITE_CSV_COLUMNS = ['email', 'name', 'language', 'batch', 'branch', 'year'] as const;

/** Splits CSV text into rows of cells (RFC 4180 quoting; CRLF or LF line ends; BOM ignored). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Validates an invite CSV. `alreadyInvited` are lower-case emails the campaign already has. */
export function previewInviteCsv(
  text: string,
  alreadyInvited: ReadonlySet<string> = new Set(),
): InvitePreview {
  const rows = parseCsvRows(text);
  const errors: InvitePreview['errors'] = [];
  const valid: InvitePreview['valid'] = [];
  const duplicates = new Set<string>();
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(INVITE_CSV_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof INVITE_CSV_COLUMNS)[number],
    number
  >;
  if (col.email < 0) {
    return {
      valid,
      errors: [{ line: 1, message: 'The first row must be a header with an "email" column.' }],
      duplicates: [],
    };
  }
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    const cells = rows[i]!;
    if (cells.every((c) => c.trim() === '')) continue;
    const get = (name: (typeof INVITE_CSV_COLUMNS)[number]) =>
      col[name] >= 0 ? (cells[col[name]] ?? '').trim() : '';
    const email = get('email').toLowerCase();
    const year = get('year');
    const language = get('language').toLowerCase();
    const parsed = InviteInput.safeParse({
      email,
      name: get('name') || null,
      language: language || undefined,
      tags: {
        batch: get('batch') || null,
        branch: get('branch') || null,
        year: year ? Number(year) : null,
      },
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = issue.path.at(-1);
      errors.push({
        line,
        message:
          field === 'email'
            ? `"${email || '(empty)'}" is not a valid email address.`
            : field === 'language'
              ? `Language must be en, hi or te (got "${language}").`
              : field === 'year'
                ? `Year must be a four-digit year (got "${year}").`
                : `${String(field ?? 'Row')}: ${issue.message}`,
      });
      continue;
    }
    if (seen.has(email) || alreadyInvited.has(email)) {
      duplicates.add(email);
      continue;
    }
    seen.add(email);
    if (valid.length >= MAX_INVITES_PER_REQUEST) {
      errors.push({
        line,
        message: `At most ${MAX_INVITES_PER_REQUEST} invites can be uploaded at once.`,
      });
      break;
    }
    valid.push(parsed.data);
  }
  return { valid, errors, duplicates: [...duplicates] };
}
