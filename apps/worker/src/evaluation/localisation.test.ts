import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';
import { outputLanguage } from './language.js';
import { reportReadyEmail, submittedEmail } from './notify-messages.js';

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
