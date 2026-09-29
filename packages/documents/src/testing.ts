/**
 * TEST SUPPORT ONLY (imported as '@cbi/documents/testing'). Builds parsing
 * fixtures in code so no binary files are committed and every fixture's
 * contents are visible in review.
 */
import { strToU8, zipSync } from 'fflate';

const escapePdf = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A valid single- or multi-page PDF with a real text layer (Helvetica). */
export function buildPdf(pages: string[][]): Buffer {
  return buildPositionedPdf(
    pages.map((lines) => lines.map((text, i) => ({ x: 50, y: 780 - i * 16, text }))),
  );
}

/** A run of text drawn at (x, y) in points (A4 page: 595 × 842, origin bottom-left). */
export interface PositionedText {
  x: number;
  y: number;
  text: string;
}

/** A PDF whose text runs sit exactly where given: for layout (tables, columns) fixtures. */
export function buildPositionedPdf(pages: PositionedText[][]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1: catalog, 2: pages, 3: font; then per page a page object and a content stream.
  let next = 4;
  const pageObjects: [number, string][] = [];
  for (const runs of pages) {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    const ops = runs
      .map((r) => `BT /F1 11 Tf ${r.x} ${r.y} Td (${escapePdf(r.text)}) Tj ET`)
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
  return serialisePdf(objects);
}

/**
 * A "scanned" PDF: every page is one image (a 2x2 grey bitmap scaled to the
 * page) and there is no text layer at all.
 */
export function buildScannedPdf(pageCount: number): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  let next = 4;
  const pageObjects: [number, string][] = [];
  const ops = 'q 495 0 0 742 50 50 cm /Im1 Do Q';
  for (let i = 0; i < pageCount; i++) {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    pageObjects.push([
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    ]);
    pageObjects.push([contentId, `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`]);
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const pixels = '\x80\x40\x40\x80';
  objects[3] = `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`;
  for (const [id, body] of pageObjects) objects[id] = body;
  return serialisePdf(objects);
}

function serialisePdf(objects: string[]): Buffer {
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

const CONTENT_TYPES =`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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

/**
 * A synthetic LinkedIn "Save to PDF" profile (invented person and companies):
 * the sidebar (Contact, Top Skills, Languages, Certifications) at the left,
 * drawn first, and the main column (name, headline, location, Summary,
 * Experience with a company's grouped roles, Education) to its right, as the
 * real export lays them out. Only characters Helvetica's standard encoding
 * shares with Latin-1 are used, so hyphens stand in for bullets and dashes.
 */
export const LINKEDIN_SIDEBAR = [
  'Contact',
  'priya.demo@example.com',
  'www.linkedin.com/in/priya-demo',
  '(LinkedIn)',
  'Top Skills',
  'Node.js',
  'PostgreSQL',
  'Kubernetes',
  'Languages',
  'English (Full Professional)',
  'Certifications',
  'AWS Certified Developer',
];
export const LINKEDIN_MAIN = [
  'Priya Demo',
  'Senior Backend Engineer at Acme Payments',
  'Hyderabad, Telangana, India',
  'Summary',
  'Backend engineer who builds reliable payment systems with Node.js and',
  'PostgreSQL.',
  'Experience',
  'Acme Payments',
  '3 years 2 months',
  'Senior Software Engineer',
  'January 2023 - Present (1 year 9 months)',
  'Hyderabad, Telangana, India',
  '- Designed an idempotent payments ledger handling 2M transactions a day.',
  '- Reduced p95 latency by 40% by moving hot reads to Redis.',
  'Software Engineer',
  'August 2021 - December 2022 (1 year 5 months)',
  'Built REST APIs in TypeScript for merchant onboarding.',
  'Globex Labs',
  'Software Engineering Intern',
  'January 2021 - June 2021 (6 months)',
  'Wrote integration tests for the billing service.',
  'Education',
  'JNTU Hyderabad',
  'Bachelor of Technology - BTech, Computer Science (2017 - 2021)',
];

export function buildLinkedInProfilePdf(): Buffer {
  // Sidebar and main column use different line grids, so their rows never merge.
  return buildPositionedPdf([
    [
      ...LINKEDIN_SIDEBAR.map((text, i) => ({ x: 30, y: 800 - i * 14, text })),
      ...LINKEDIN_MAIN.map((text, i) => ({ x: 220, y: 793 - i * 15, text })),
      { x: 270, y: 30, text: 'Page 1 of 1' },
    ],
  ]);
}

/** The same profile as a candidate would copy it from their LinkedIn page (web order). */
export const LINKEDIN_PASTED_TEXT = [
  'Priya Demo',
  'Senior Backend Engineer at Acme Payments',
  'About',
  'Backend engineer who builds reliable payment systems.',
  'Experience',
  'Senior Software Engineer',
  'Senior Software Engineer',
  'Acme Payments · Full-time',
  'Jan 2023 - Present · 1 yr 9 mos',
  'Hyderabad, Telangana, India · On-site',
  'Designed an idempotent payments ledger handling 2M transactions a day.',
  'Software Engineer',
  'Aug 2021 - Dec 2022 · 1 yr 5 mos',
  'Built REST APIs in TypeScript for merchant onboarding.',
  'Education',
  'JNTU Hyderabad',
  'Bachelor of Technology - BTech, Computer Science',
  '2017 - 2021',
  'Skills',
  'Node.js',
  'Endorsed by 3 colleagues at Acme Payments',
  'PostgreSQL',
  'Show all 12 skills',
].join('\n');

export const SAMPLE_RESUME_LINES = [
  'Priya Sharma - Backend Engineer',
  'Experience: 4 years building REST APIs with Node.js, TypeScript and PostgreSQL.',
  'Acme Payments (2022 - present): designed an idempotent payments ledger handling 2M transactions a day.',
  'Led migration from a monolith to services on Kubernetes; reduced p95 latency by 40%.',
  'Skills: Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes, AWS, system design.',
  'Education: B.Tech Computer Science, JNTU Hyderabad, 2020.',
];
