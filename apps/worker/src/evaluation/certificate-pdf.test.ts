import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { certificateVerifyUrl } from '../processors/certificate.js';
import { renderCertificatePdf, type CertificateFacts } from './certificate-pdf.js';
import { fontsAvailable } from './pdf.js';

const facts: CertificateFacts = {
  code: 'CPI-ABCD-EFGH-JKLM',
  candidateName: 'శ్రీ లక్ష్మి',
  roleTitle: 'बैकएंड इंजीनियर',
  overall: 78,
  band: 'READY_WITH_GAPS',
  completedAt: new Date('2026-09-20T10:00:00Z'),
  issuedAt: new Date('2026-09-21T10:00:00Z'),
  verifyUrl: 'https://interview.test/verify/CPI-ABCD-EFGH-JKLM',
};

afterEach(() => vi.restoreAllMocks());

const written = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

describe('renderCertificatePdf', () => {
  it.skipIf(!fontsAvailable())('states the facts, the code and the verification link', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const pdf = await renderCertificatePdf(facts, { compress: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const all = written(text);
    for (const part of [
      'శ్రీ లక్ష్మి',
      'बैकएंड इंजीनियर',
      'Interview-ready with gaps',
      'Overall readiness: 78 / 100',
      'CPI-ABCD-EFGH-JKLM',
      facts.verifyUrl,
    ]) {
      expect(all).toContain(part);
    }
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+HindGuntur-Bold/);
    expect(raw).toContain(`/URI (${facts.verifyUrl})`);
  });

  it('falls back to the standard fonts without the font files', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const empty = mkdtempSync(join(tmpdir(), 'no-fonts-'));
    const pdf = await renderCertificatePdf(
      { ...facts, candidateName: null, overall: null },
      { fontDir: empty, compress: false },
    );
    expect(pdf.toString('latin1')).toContain('/BaseFont /Helvetica');
    const all = written(text);
    expect(all).toContain('the candidate');
    expect(all).not.toContain('Overall readiness');
  });
});

describe('certificateVerifyUrl', () => {
  it('joins the candidate site and the code', () => {
    expect(certificateVerifyUrl('https://interview.test/', 'CPI-2222-2222-2222')).toBe(
      'https://interview.test/verify/CPI-2222-2222-2222',
    );
  });
});
