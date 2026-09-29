/** Byte-order mark, so spreadsheet apps read Hindi and Telugu text correctly. */
export const CSV_BOM = String.fromCharCode(0xfeff);

/** CSV cell: quoted, and text that a spreadsheet would run as a formula is neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (CRLF-terminated, as RFC 4180 and spreadsheet apps expect). */
export const csvLine = (cells: readonly unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;
