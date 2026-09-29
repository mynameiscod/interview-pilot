import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractDocumentText } from './extract.js';
import { docxLayout, textLayout } from './layout.js';
import {
  buildDocx,
  buildPdf,
  buildPositionedPdf,
  buildScannedPdf,
  SAMPLE_RESUME_LINES,
} from './testing.js';

const docxWithBody = (body: string) =>
  buildDocx(['placeholder'], {
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });

const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('PDF layout signals', () => {
  it('a plain single-column resume has no risks', async () => {
    const { layout } = await extractDocumentText(buildPdf([SAMPLE_RESUME_LINES]));
    expect(layout).toMatchObject({
      pages: 1,
      tablesSuspected: false,
      columnsSuspected: false,
      imageOnly: false,
    });
    expect(layout.words).toBeGreaterThan(50);
  });

  it('right-aligned dates are not a second column', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => [
      { x: 50, y: 780 - i * 20, text: `Role ${i} at Company ${i}` },
      // Right-aligned: different start positions, same end.
      {
        x: 470 - (i % 3) * 18,
        y: 780 - i * 20,
        text: i % 2 ? 'Jan 2020 - Present' : '2019 - 2021',
      },
    ]);
    const { layout } = await extractDocumentText(
      buildPositionedPdf([
        [
          ...rows.flat(),
          ...SAMPLE_RESUME_LINES.map((text, i) => ({ x: 50, y: 500 - i * 16, text })),
        ],
      ]),
    );
    expect(layout.columnsSuspected).toBe(false);
    expect(layout.tablesSuspected).toBe(false);
  });

  it('flags a skills table (rows of three or more cells)', async () => {
    const table = Array.from({ length: 4 }, (_, i) => [
      { x: 50, y: 700 - i * 16, text: `Skill ${i}` },
      { x: 220, y: 700 - i * 16, text: 'Expert' },
      { x: 400, y: 700 - i * 16, text: `${i + 2} years` },
    ]).flat();
    const { layout } = await extractDocumentText(
      buildPositionedPdf([
        [...SAMPLE_RESUME_LINES.map((text, i) => ({ x: 50, y: 800 - i * 16, text })), ...table],
      ]),
    );
    expect(layout.tablesSuspected).toBe(true);
  });

  it('flags a two-column layout and reads it column by column', async () => {
    const left = ['Skills', 'Node.js', 'Redis', 'Docker', 'Languages', 'English', 'Hindi'];
    const right = SAMPLE_RESUME_LINES.map((l) => l.slice(0, 40));
    const { layout, text } = await extractDocumentText(
      buildPositionedPdf([
        [
          // Interleaved in the content stream, as many templates draw them.
          ...right.flatMap((line, i) => [
            { x: 250, y: 780 - i * 16, text: line },
            ...(left[i] ? [{ x: 40, y: 780 - i * 16, text: left[i]! }] : []),
          ]),
          { x: 40, y: 780 - 6 * 16, text: left[6]! },
        ],
      ]),
    );
    expect(layout.columnsSuspected).toBe(true);
    expect(text.split('\n').slice(0, left.length)).toEqual(left);
  });

  it('marks a scan as image-only, even when OCR reads it', async () => {
    const { layout } = await extractDocumentText(buildScannedPdf(1), {
      ocr: async () => SAMPLE_RESUME_LINES.join('\n'),
    });
    expect(layout).toMatchObject({ imageOnly: true, pages: 1 });
  });
});

describe('Word and text layout signals', () => {
  it('finds Word tables and multi-column sections', () => {
    const table = `<w:tbl><w:tr><w:tc>${para('Skill')}</w:tc><w:tc>${para('Level')}</w:tc></w:tr></w:tbl>`;
    expect(docxLayout(docxWithBody(para('Resume') + table))).toEqual({
      tablesSuspected: true,
      columnsSuspected: false,
    });
    const columns = `${para('Resume')}<w:sectPr><w:cols w:num="2" w:space="720"/></w:sectPr>`;
    expect(docxLayout(docxWithBody(columns)).columnsSuspected).toBe(true);
    expect(docxLayout(buildDocx(SAMPLE_RESUME_LINES))).toEqual({
      tablesSuspected: false,
      columnsSuspected: false,
    });
    expect(docxLayout(Buffer.from('not a zip'))).toEqual({
      tablesSuspected: false,
      columnsSuspected: false,
    });
  });

  it('reports Word layout through the extractor', async () => {
    const table = `<w:tbl><w:tr><w:tc>${para('Skill')}</w:tc></w:tr></w:tbl>`;
    const result = await extractDocumentText(
      docxWithBody(SAMPLE_RESUME_LINES.map(para).join('') + table),
    );
    expect(result.layout).toMatchObject({ tablesSuspected: true, pages: null });
  });

  it('treats tab-separated lines in plain text as a table', async () => {
    expect(textLayout('a\tb\tc\nd\te\tf\ng\th\ti').tablesSuspected).toBe(true);
    expect(textLayout('a\tb\nplain line').tablesSuspected).toBe(false);
    const result = await extractDocumentText(
      Buffer.from(
        `${SAMPLE_RESUME_LINES.join('\n')}\nSkill\tLevel\tYears\nGo\tGood\t2\nSQL\tGood\t3`,
      ),
    );
    expect(result.layout.tablesSuspected).toBe(true);
  });
});
