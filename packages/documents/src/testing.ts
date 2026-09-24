/**
 * TEST SUPPORT ONLY (imported as '@cbi/documents/testing'). Builds parsing
 * fixtures in code so no binary files are committed and every fixture's
 * contents are visible in review.
 */
import { strToU8, zipSync } from 'fflate';

const escapePdf = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A valid single- or multi-page PDF with a real text layer (Helvetica). */
export function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1: catalog, 2: pages, 3: font; then per page a page object and a content stream.
  let next = 4;
  const pageObjects: [number, string][] = [];
  for (const lines of pages) {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    const ops = lines
      .map((line, i) => `BT /F1 11 Tf 50 ${780 - i * 16} Td (${escapePdf(line)}) Tj ET`)
      .join('\n');
    pageObjects.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    pageObjects.push([
      contentId,
      `<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`,
    ]);
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (const [id, body] of pageObjects) objects[id] = body;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const escapeXml = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/** A minimal valid DOCX, one paragraph per entry. `extra` adds raw zip parts. */
export function buildDocx(paragraphs: string[], extra: Record<string, Uint8Array> = {}): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return Buffer.from(
    zipSync(
      {
        '[Content_Types].xml': strToU8(CONTENT_TYPES),
        '_rels/.rels': strToU8(ROOT_RELS),
        'word/document.xml': strToU8(document),
        ...extra,
      },
      { level: 9 },
    ),
  );
}

/** A DOCX carrying a part that inflates to `inflatedMb` megabytes (zip bomb). */
export function buildDocxBomb(inflatedMb: number): Buffer {
  return buildDocx(['Harmless looking resume'], {
    'word/media/padding.bin': new Uint8Array(inflatedMb * 1024 * 1024),
  });
}

export const SAMPLE_RESUME_LINES = [
  'Priya Sharma - Backend Engineer',
  'Experience: 4 years building REST APIs with Node.js, TypeScript and PostgreSQL.',
  'Acme Payments (2022 - present): designed an idempotent payments ledger handling 2M transactions a day.',
  'Led migration from a monolith to services on Kubernetes; reduced p95 latency by 40%.',
  'Skills: Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes, AWS, system design.',
  'Education: B.Tech Computer Science, JNTU Hyderabad, 2020.',
];
