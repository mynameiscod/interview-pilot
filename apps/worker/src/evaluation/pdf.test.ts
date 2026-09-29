import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportContent } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontsAvailable } from '@cbi/pdf-fonts';
import { renderReportPdf, reportLanguage } from './pdf.js';
import { REPORT_DISCLAIMER } from './report-content.js';
import { pdfMessages } from './report-messages.js';

const HINDI = 'आपने अच्छा उत्तर दिया।';
// "శ్రీ" and "ప్రశ్నలు" crash fontkit with Noto Sans Telugu (why Hind Guntur is used).
const TELUGU = 'శ్రీ, మీరు ప్రశ్నలు బాగా సమాధానం ఇచ్చారు';

/** A minimal report with Hindi and Telugu in the free-text fields. */
const content = ReportContent.parse({
  schemaVersion: 1,
  integrity: null,
  header: {
    title: 'बैकएंड इंजीनियर',
    companyName: 'Acme',
    mode: 'TEXT',
    language: 'hi',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:30:00.000Z',
    durationSec: 1800,
    endReason: null,
  },
  overall: {
    score: 72,
    band: 'READY_WITH_GAPS',
    confidence: {
      level: 'MEDIUM',
      value: 0.6,
      factors: {
        independentQuestions: 0.5,
        practicalEvidence: 0.6,
        consistency: 0.7,
        completeness: 0.6,
      },
    },
    assessedWeight: 1,
  },
  summary: `Good answers overall. ${HINDI} ${TELUGU}`,
  dimensions: [
    {
      key: 'api-design',
      name: 'API design',
      category: 'TECHNICAL',
      weight: 100,
      score: 72,
      rationale: `Clear reasoning (${TELUGU}).`,
      evidence: [
        {
          id: 'e1',
          claim: HINDI,
          strength: 3,
          quote: null,
          questionId: 'q1',
          question: 'Design a rate limiter.',
        },
      ],
      fallback: false,
    },
  ],
  strengths: [{ text: TELUGU, dimensionKey: 'api-design' }],
  gaps: [{ text: `Mixed: REST ${HINDI} and ${TELUGU}`, dimensionKey: null }],
  rounds: [],
  coverage: [],
  plan: {
    next24h: [{ action: 'अभ्यास करें', why: 'Practice helps.', dimensionKey: null }],
    next3Days: [{ action: 'Review caching', why: TELUGU, dimensionKey: null }],
    next7Days: [{ action: 'Mock interview', why: 'Build confidence.', dimensionKey: null }],
  },
  previous: null,
  transcript: null,
  disclaimer: 'This report is guidance, not a hiring decision.',
});

afterEach(() => vi.restoreAllMocks());

describe('renderReportPdf', () => {
  it.skipIf(!fontsAvailable())('embeds the fonts and keeps Hindi and Telugu text', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const pdf = await renderReportPdf(content, { compress: false });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const written = text.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(HINDI);
    expect(written).toContain(TELUGU);
    expect(written).toContain('बैकएंड इंजीनियर');

    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+HindGuntur-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Bold/);
    expect(raw).not.toContain('/Helvetica');
  });

  it.skipIf(!fontsAvailable())('falls back to the standard fonts if shaping throws', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    text.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of null (reading 'xCoordinate')");
    });
    const raw = (await renderReportPdf(content, { compress: false })).toString('latin1');
    expect(raw).toContain('/BaseFont /Helvetica');
    expect(raw).not.toContain('Noto');
  });

  it.skipIf(!fontsAvailable())('writes headings and labels in the report language', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    await renderReportPdf(
      { ...content, disclaimer: REPORT_DISCLAIMER },
      { compress: false, language: 'te' },
    );
    const written = text.mock.calls.map((c) => String(c[0])).join('');
    const te = pdfMessages('te');
    expect(written).toContain(te.title);
    expect(written).toContain(te.overall);
    expect(written).toContain(te.bands.READY_WITH_GAPS);
    expect(written).toContain(te.next24h);
    // The stored English disclaimer is printed in the report language.
    expect(written).toContain(te.disclaimer);
    expect(written).not.toContain('Interview readiness report');
    expect(written).not.toContain(REPORT_DISCLAIMER);
  });

  it('takes the language from the session, or from the summary’s script when automatic', () => {
    expect(reportLanguage(content)).toBe('hi');
    const auto = (summary: string) =>
      reportLanguage({ ...content, header: { ...content.header, language: 'auto' }, summary });
    expect(auto(TELUGU)).toBe('te');
    expect(auto('Good answers overall.')).toBe('en');
  });

  it('falls back to the standard fonts and pdfSafe without the font files', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const empty = mkdtempSync(join(tmpdir(), 'no-fonts-'));
    expect(fontsAvailable(empty)).toBe(false);

    const pdf = await renderReportPdf(content, { fontDir: empty, compress: false });
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/BaseFont /Helvetica');
    expect(raw).not.toContain('Noto');
    const written = text.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain(HINDI);
    expect(written).toContain('Good answers overall. ??');
    // The standard fonts cannot print Hindi headings: they are in English.
    expect(written).toContain('Interview readiness report');
  });
});

describe('coaching sections', () => {
  it('renders compact question cards, STAR, delivery and the benchmark', async () => {
    const text = vi.spyOn(PDFDocument.prototype, 'text');
    const coached = ReportContent.parse({
      ...content,
      questions: [
        {
          questionId: 'q1',
          seq: 1,
          roundType: 'BEHAVIORAL',
          question: 'Tell me about a conflict.',
          answer: 'I talked to him.',
          spoken: true,
          behavioural: true,
          verdict: 'WEAK',
          whatWorked: ['Acted quickly.'],
          missing: ['The outcome.'],
          improvedAnswer: 'I talked to my teammate privately and we agreed on [the change].',
          star: { situation: false, task: false, action: true, result: false, source: 'AI' },
          fallback: false,
        },
      ],
      structure: {
        behaviouralAnswers: 1,
        complete: 0,
        counts: { situation: 0, task: 0, action: 1, result: 0 },
        weakest: 'result',
      },
      delivery: {
        summary: {
          answers: 1,
          durationSec: 60,
          wordCount: 180,
          wpm: 180,
          fillerCount: 9,
          fillerRate: 5,
          topFillers: [{ text: 'um', count: 9 }],
          longPauses: 2,
          hedgeCount: 0,
          topHedges: [],
        },
        tips: ['PACE_FAST', 'FILLERS'],
        answers: [],
      },
      benchmark: {
        percentile: 64,
        sampleSize: 41,
        basis: 'ROLE',
        roleTitle: 'Backend Engineer',
        family: null,
        windowDays: 180,
      },
    });
    const empty = mkdtempSync(join(tmpdir(), 'no-fonts-'));
    const pdf = await renderReportPdf(coached, { fontDir: empty, compress: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const written = text.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('Better than 64% of 41 candidates practising for Backend Engineer');
    expect(written).toContain('Answer by answer');
    expect(written).toContain('Verdict: Needs work');
    expect(written).toContain('Structure (STAR): Action - missing Situation, Task, Result');
    expect(written).toContain('Example answer (built from your own answer)');
    expect(written).toContain('Most often missing: result');
    expect(written).toContain('Pace: 180 words per minute (target 120-160)');
    expect(written).toContain('never affects your scores');
  });
});
