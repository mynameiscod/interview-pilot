import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultFontDir,
  fontsAvailable,
  pdfSafe,
  registerScriptFonts,
  scriptRuns,
  writeScriptText,
} from './index.js';

const HINDI = 'आपने अच्छा उत्तर दिया।';
// "శ్రీ" and "ప్రశ్నలు" crash fontkit with Noto Sans Telugu (why Hind Guntur is used).
const TELUGU = 'శ్రీ, మీరు ప్రశ్నలు బాగా సమాధానం ఇచ్చారు';

afterEach(() => vi.restoreAllMocks());

describe('scriptRuns', () => {
  it('splits mixed English, Hindi and Telugu into script runs', () => {
    expect(scriptRuns(`Score: ${HINDI} then ${TELUGU}!`)).toEqual([
      { script: 'latin', text: 'Score: ' },
      { script: 'devanagari', text: `${HINDI} ` },
      { script: 'latin', text: 'then ' },
      { script: 'telugu', text: `${TELUGU}!` },
    ]);
  });

  it('keeps marks, joiners, digits and punctuation with the current run', () => {
    const zwj = String.fromCodePoint(0x200d);
    const acute = String.fromCodePoint(0x0301);
    // Leading neutrals join the first script that follows.
    const hindi = `- 2 क्ष${zwj}त्र, 3.`;
    expect(scriptRuns(hindi)).toEqual([{ script: 'devanagari', text: hindi }]);
    expect(scriptRuns(`cafe${acute} (x)`)).toEqual([{ script: 'latin', text: `cafe${acute} (x)` }]);
    // Only the Devanagari font has the danda (Telugu text uses it too) and NBSP is Latin.
    const danda = String.fromCodePoint(0x0964);
    const nbsp = String.fromCodePoint(0xa0);
    expect(scriptRuns(`${TELUGU}${danda}${nbsp}`)).toEqual([
      { script: 'telugu', text: TELUGU },
      { script: 'devanagari', text: danda },
      { script: 'latin', text: nbsp },
    ]);
    expect(scriptRuns('12 - 3')).toEqual([{ script: 'latin', text: '12 - 3' }]);
    expect(scriptRuns('')).toEqual([]);
  });

  it('never loses characters', () => {
    const text = `A ${HINDI} & ${TELUGU} @ 5 ${String.fromCodePoint(0xa8f2)}`;
    expect(
      scriptRuns(text)
        .map((r) => r.text)
        .join(''),
    ).toBe(text);
  });
});

describe('embedded fonts', () => {
  it('ships every script with the package', () => {
    expect(fontsAvailable()).toBe(true);
    expect(fontsAvailable(mkdtempSync(join(tmpdir(), 'no-fonts-')))).toBe(false);
  });

  it('writes a mixed-script paragraph with one font per run', async () => {
    const doc = new PDFDocument({ compress: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', resolve));
    registerScriptFonts(doc, defaultFontDir());
    const text = vi.spyOn(doc, 'text');
    writeScriptText(doc, `Name: ${HINDI} ${TELUGU}`, 'bold', 10, {}, { x: 60, y: 80 });
    // The first run starts at the given position; the others continue it.
    expect(text.mock.calls[0]!.slice(0, 3)).toEqual(['Name: ', 60, 80]);
    expect(text.mock.calls.map((c) => c[0]).join('')).toBe(`Name: ${HINDI} ${TELUGU}`);
    doc.end();
    await done;
    const raw = Buffer.concat(chunks).toString('latin1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Bold/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+HindGuntur-Bold/);
  });
});

describe('pdfSafe', () => {
  it('maps typographic punctuation and replaces non-Latin-1 text with "?"', () => {
    expect(pdfSafe('“Hi” – ok…')).toBe('"Hi" - ok...');
    expect(pdfSafe('नमस्ते')).toBe('??????');
    expect(pdfSafe('తె')).toBe('??');
  });
});
