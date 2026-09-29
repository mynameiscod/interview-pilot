#!/usr/bin/env node
// Downloads the fonts @cbi/pdf-fonts ships (report PDFs, receipts and credit notes): Noto Sans (Latin), Noto Sans
// Devanagari (Hindi) and Hind Guntur (Telugu).
//
//   node infrastructure/scripts/fetch-fonts.mjs          -> fetches missing files into packages/pdf-fonts/fonts
//   node infrastructure/scripts/fetch-fonts.mjs --force  -> re-downloads every file
//
// The fonts are committed, so this is only needed to restore or refresh them. Without them PDFs
// fall back to the standard PDF fonts and non-Latin text prints as "?".
// Static (non-variable) TTFs; all are SIL OFL 1.1.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = join(root, 'packages/pdf-fonts/fonts');
const force = process.argv.includes('--force');

const NOTO = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts';
const GOOGLE = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const files = {
  'NotoSans-Regular.ttf': `${NOTO}/NotoSans/unhinted/ttf/NotoSans-Regular.ttf`,
  'NotoSans-Bold.ttf': `${NOTO}/NotoSans/unhinted/ttf/NotoSans-Bold.ttf`,
  'NotoSans-Italic.ttf': `${NOTO}/NotoSans/unhinted/ttf/NotoSans-Italic.ttf`,
  'NotoSansDevanagari-Regular.ttf': `${NOTO}/NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Regular.ttf`,
  'NotoSansDevanagari-Bold.ttf': `${NOTO}/NotoSansDevanagari/unhinted/ttf/NotoSansDevanagari-Bold.ttf`,
  // Telugu uses Hind Guntur: fontkit (pdfkit's shaper) crashes on common conjuncts such as
  // "శ్రీ" with every Noto Sans Telugu build (null GPOS mark anchors).
  'HindGuntur-Regular.ttf': `${GOOGLE}/hindguntur/HindGuntur-Regular.ttf`,
  'HindGuntur-Bold.ttf': `${GOOGLE}/hindguntur/HindGuntur-Bold.ttf`,
  'OFL.txt': 'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt',
  'OFL-HindGuntur.txt': `${GOOGLE}/hindguntur/OFL.txt`,
};

// TrueType / OpenType signatures: 0x00010000, 'true', 'OTTO'.
const isFont = (buf) =>
  buf.length > 12 &&
  (buf.readUInt32BE(0) === 0x00010000 || ['true', 'OTTO'].includes(buf.toString('latin1', 0, 4)));
const isValid = (name, buf) =>
  name.endsWith('.ttf') ? isFont(buf) : buf.toString('utf8').includes('SIL OPEN FONT LICENSE');

mkdirSync(target, { recursive: true });
let failed = 0;
for (const [name, url] of Object.entries(files)) {
  const path = join(target, name);
  if (!force && existsSync(path) && isValid(name, readFileSync(path))) {
    console.log(`fetch-fonts: ${name} already present`);
    continue;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isValid(name, buf)) throw new Error('unexpected content (not a font / licence file)');
    writeFileSync(path, buf);
    console.log(`fetch-fonts: ${name} (${Math.round(statSync(path).size / 1024)} KB)`);
  } catch (err) {
    failed++;
    console.error(`fetch-fonts: ${name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

if (failed) {
  console.error(`fetch-fonts: ${failed} file(s) failed; PDFs fall back to the standard fonts.`);
  process.exit(1);
}
console.log(`fetch-fonts: all fonts are in ${target}`);
