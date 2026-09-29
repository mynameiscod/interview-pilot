import { unzipSync } from 'fflate';

/**
 * Layout heuristics for ATS formatting checks. They look at where text sits
 * (PDF), at the Word markup (DOCX) or at tab characters (plain text); none of
 * them renders a page. Results are "suspected" signals, never certainties.
 */

/** One positioned text run from a PDF page (pdf.js text content). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  hasEOL: boolean;
}

export interface PdfPageItems {
  width: number;
  items: PdfTextItem[];
}

export interface LayoutSignals {
  tablesSuspected: boolean;
  columnsSuspected: boolean;
}

/** A gap wider than this share of the page width separates two cells or columns. */
const CELL_GAP = 0.08;
/** Rows whose second cell starts within this many points count as the same column. */
const COLUMN_TOLERANCE = 12;
/** Rows needed before a repeated pattern counts as a table or a column. */
const MIN_TABLE_ROWS = 3;
const MIN_COLUMN_ROWS = 6;

interface Row {
  y: number;
  /** Cells: runs of items without a wide gap, left to right. */
  cells: { x: number; end: number; text: string }[];
}

/** Groups a page's items into visual rows and cells. */
function rowsOf(page: PdfPageItems): Row[] {
  const byY = new Map<number, PdfTextItem[]>();
  for (const item of page.items) {
    if (!item.str.trim()) continue;
    const key = Math.round(item.y / 2) * 2;
    const list = byY.get(key) ?? [];
    list.push(item);
    byY.set(key, list);
  }
  const gap = page.width * CELL_GAP;
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, items]) => {
      items.sort((a, b) => a.x - b.x);
      const cells: Row['cells'] = [];
      for (const item of items) {
        const last = cells.at(-1);
        if (last && item.x - last.end <= gap) {
          last.text += (item.x - last.end > 1 ? ' ' : '') + item.str;
          last.end = Math.max(last.end, item.x + item.width);
        } else {
          cells.push({ x: item.x, end: item.x + item.width, text: item.str });
        }
      }
      return { y, cells };
    });
}

/**
 * Where a second column starts on this page, or null. A column is a cell
 * start shared (within a few points) by many rows, in the middle band of the
 * page, with text to its left on at least some of those rows. Right-aligned
 * dates end at the same place but start at different ones, so they do not
 * form a column.
 */
function columnStart(page: PdfPageItems, rows: Row[]): number | null {
  const starts = rows.flatMap((r) =>
    r.cells
      .slice(1)
      .map((c) => c.x)
      .filter((x) => x > page.width * 0.2 && x < page.width * 0.7),
  );
  // Rows that start directly in the right column also count (a sidebar layout),
  // but only when some text sits to the left of it somewhere on the page.
  const leftmost = Math.min(...rows.map((r) => r.cells[0]!.x));
  const firstStarts = rows
    .map((r) => r.cells[0]!.x)
    .filter(
      (x) => x > page.width * 0.2 && x < page.width * 0.7 && leftmost < x - page.width * 0.15,
    );
  const candidates = [...starts, ...firstStarts];
  let best: { x: number; count: number } | null = null;
  for (const x of candidates) {
    const count = candidates.filter((other) => Math.abs(other - x) <= COLUMN_TOLERANCE).length;
    if (!best || count > best.count) best = { x, count };
  }
  return best && best.count >= MIN_COLUMN_ROWS ? best.x - COLUMN_TOLERANCE : null;
}

export interface PdfLayout extends LayoutSignals {
  /**
   * The text rebuilt column by column (left column first) when a two-column
   * layout was found, so sections are not interleaved line by line. Null
   * when the stream order is kept.
   */
  columnText: string | null;
}

export function pdfLayout(pages: readonly PdfPageItems[]): PdfLayout {
  let tableRows = 0;
  let columnsSuspected = false;
  const rebuilt: string[] = [];
  for (const page of pages) {
    const rows = rowsOf(page);
    tableRows += rows.filter((r) => r.cells.length >= 3).length;
    const split = columnStart(page, rows);
    if (split === null) {
      rebuilt.push(rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n'));
      continue;
    }
    columnsSuspected = true;
    const left: string[] = [];
    const right: string[] = [];
    for (const row of rows) {
      const l = row.cells.filter((c) => c.x < split).map((c) => c.text);
      const r = row.cells.filter((c) => c.x >= split).map((c) => c.text);
      if (l.length) left.push(l.join(' '));
      if (r.length) right.push(r.join(' '));
    }
    rebuilt.push([...left, ...right].join('\n'));
  }
  return {
    tablesSuspected: tableRows >= MIN_TABLE_ROWS,
    columnsSuspected,
    columnText: columnsSuspected ? rebuilt.join('\n') : null,
  };
}

/**
 * Word tables (`<w:tbl>`) and multi-column sections (`<w:cols w:num="2"…>`)
 * from the main document part. Call only after the zip passed the size checks.
 */
export function docxLayout(buf: Buffer): LayoutSignals {
  try {
    const files = unzipSync(new Uint8Array(buf), {
      filter: (f) => f.name === 'word/document.xml',
    });
    const xml = Buffer.from(files['word/document.xml'] ?? new Uint8Array()).toString('utf8');
    const cols = [...xml.matchAll(/<w:cols\b[^>]*\bw:num="(\d+)"/g)].map((m) => Number(m[1]));
    return {
      tablesSuspected: /<w:tbl\b/.test(xml),
      columnsSuspected: cols.some((n) => n > 1),
    };
  } catch {
    return { tablesSuspected: false, columnsSuspected: false };
  }
}

/** Plain text: several lines with two or more tab-separated cells look like a table. */
export function textLayout(text: string): LayoutSignals {
  const tabbed = text.split('\n').filter((line) => (line.match(/\t+/g) ?? []).length >= 2).length;
  return { tablesSuspected: tabbed >= MIN_TABLE_ROWS, columnsSuspected: false };
}

export const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;
