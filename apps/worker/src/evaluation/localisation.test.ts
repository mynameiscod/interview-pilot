import { INTEGRITY_NOTE } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';
import { outputLanguage } from './language.js';
import { reportReadyEmail, submittedEmail } from './notify-messages.js';
import { fallbackRecommendations, REPORT_DISCLAIMER } from './report-content.js';
import { fallbackMessages, fill, pdfMessages } from './report-messages.js';

const SCRIPT = { hi: /[ऀ-ॿ]/, te: /[ఀ-౿]/ } as const;

/** Every string in a (nested) message object. */
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Object.values(v as object).flatMap(strings);
/** Every key path in a (nested) message object. */
const keys = (v: unknown, prefix = ''): string[] =>
  typeof v === 'string'
    ? [prefix]
    : Object.entries(v as object).flatMap(([k, x]) => keys(x, `${prefix}.${k}`));

describe('report messages', () => {
  it('have the same keys and placeholders in every language', () => {
    for (const lang of ['hi', 'te'] as const) {
      expect(keys(fallbackMessages(lang))).toEqual(keys(fallbackMessages('en')));
      expect(keys(pdfMessages(lang)).sort()).toEqual(keys(pdfMessages('en')).sort());
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      const en = strings(pdfMessages('en'));
      strings(pdfMessages(lang)).forEach((s, i) =>
        expect(placeholders(s)).toEqual(placeholders(en[i]!)),
      );
      for (const s of [...strings(fallbackMessages(lang)), ...strings(pdfMessages(lang))]) {
        expect(s).toMatch(SCRIPT[lang]);
      }
    }
  });

  it('keep the English disclaimer and observation note identical to the stored ones', () => {
    expect(pdfMessages('en').disclaimer).toBe(REPORT_DISCLAIMER);
    expect(pdfMessages('en').integrityNote).toBe(INTEGRITY_NOTE);
  });

  it('fill placeholders and leave unknown ones', () => {
    expect(fill('{a} of {b} ({c})', { a: 1, b: 'x' })).toBe('1 of x ({c})');
  });
});

describe('fallback recommendations', () => {
  const dims = [
    { key: 'api', name: 'API design', score: 80 },
    { key: 'db', name: 'Databases', score: 40 },
    { key: 'ops', name: 'Operations', score: null },
  ];

  it('are written in the output language, keeping dimension names', () => {
    const en = fallbackRecommendations(dims);
    expect(en.summary).toBe(fallbackMessages('en').summaryScored);
    expect(en.strengths[0]!.text).toBe('Your answers showed solid evidence in API design.');
    for (const lang of ['hi', 'te'] as const) {
      const recs = fallbackRecommendations(dims, lang);
      expect(recs.summary).toMatch(SCRIPT[lang]);
      expect(recs.strengths[0]!.text).toContain('API design');
      expect(recs.strengths[0]!.text).toMatch(SCRIPT[lang]);
      expect(recs.gaps.map((g) => g.dimensionKey)).toEqual(en.gaps.map((g) => g.dimensionKey));
      const all = [
        recs.summary,
        ...recs.strengths.map((s) => s.text),
        ...recs.gaps.map((g) => g.text),
        ...Object.values(recs.plan).flatMap((items) => items.flatMap((i) => [i.action, i.why])),
      ];
      expect(all.join(' ')).not.toMatch(/\{\w+\}/);
    }
    expect(fallbackRecommendations([], 'te').summary).toBe(fallbackMessages('te').summaryUnscored);
  });
});

describe('outputLanguage', () => {
  it('uses the language chosen for the session', () => {
    expect(outputLanguage('hi', ['plain English answer'])).toBe('hi');
    expect(outputLanguage('te')).toBe('te');
    expect(outputLanguage('en', ['मैंने लॉग देखे'])).toBe('en');
  });

  it('detects the answers’ script when the session language was automatic', () => {
    expect(outputLanguage('auto', ['मैंने पहले लॉग देखे और फिर ट्रेस देखे।'])).toBe('hi');
    expect(outputLanguage('auto', ['నేను ముందు లాగ్‌లు చూశాను, తర్వాత ట్రేస్‌లు.'])).toBe('te');
    // Mostly English with a few Hindi words stays English.
    expect(outputLanguage('auto', ['I checked the logs and the traces first, फिर'])).toBe('en');
    expect(outputLanguage('auto', ['maine logs dekhe'])).toBe('en');
    expect(outputLanguage(null, [])).toBe('en');
  });
});

describe('result emails', () => {
  const link = 'https://app.example/app/reports/s1';

  it('are written in each language and keep the link and product name', () => {
    for (const language of ['en', 'hi', 'te'] as const) {
      const ready = reportReadyEmail(language, link);
      expect(ready.text).toContain(link);
      expect(ready.text).toContain('CareerPilot Interview by CodeBegun');
      expect(submittedEmail(language).text).toContain('CareerPilot Interview by CodeBegun');
    }
    expect(reportReadyEmail('en', link).subject).toBe('Your interview readiness report is ready');
    expect(reportReadyEmail('hi', link).subject).toMatch(/[ऀ-ॿ]/);
    expect(reportReadyEmail('te', link).subject).toMatch(/[ఀ-౿]/);
    expect(submittedEmail('hi').subject).not.toBe(submittedEmail('en').subject);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 10, 2, 8], 3, async (ms, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(3);
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });

  it('propagates a failure', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
