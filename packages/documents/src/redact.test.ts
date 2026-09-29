import { describe, expect, it } from 'vitest';
import { redactedTotal, redactPii } from './redact.js';

const RESUME = `Priya Sharma
Senior Backend Engineer
Email: priya.sharma+jobs@gmail.com | Phone: +91 98765 43210 | Alt: 080-41234567
LinkedIn: https://www.linkedin.com/in/priya-sharma-123/ | github.com/priyasharma
Address: Flat 4B, Lakeview Apartments, 12th Main Road, HSR Layout
Bengaluru, Karnataka 560102

Experience
- Built the payments API at Acme (2019-2023), cutting p95 latency from 800 ms to 120 ms.
- Led a team of 5 on the main order service; handled 1,200,000 orders a day.
- Sharma Logistics integration: see https://acme.dev/blog/integrations
Contact me on 9876543210 or 0091-98765-43210.`;

describe('redactPii', () => {
  const { text, counts } = redactPii(RESUME, { names: ['Priya Sharma'] });

  it('masks e-mail, phones, profile links, the address and the candidate name', () => {
    expect(text).not.toMatch(/priya|sharma/i);
    expect(text).not.toContain('@gmail.com');
    expect(text).not.toMatch(/98765|43210|41234567/);
    expect(text).not.toContain('linkedin.com/in');
    expect(text).not.toContain('github.com/priyasharma');
    expect(text).not.toMatch(/Lakeview|HSR Layout|560102/);
    expect(text).toContain('Email: [EMAIL] | Phone: [PHONE] | Alt: [PHONE]');
    expect(text).toContain('Address: [ADDRESS]');
    expect(text.split('\n')[0]).toBe('[NAME]');
    // Names: the heading and "Sharma Logistics" (the e-mail was already masked).
    expect(counts).toEqual({ EMAIL: 1, PHONE: 4, PROFILE_URL: 2, ADDRESS: 2, NAME: 2 });
    expect(redactedTotal(counts)).toBe(11);
  });

  it('keeps work content: years, amounts, metrics, team sizes and non-profile links', () => {
    expect(text).toContain('(2019-2023)');
    expect(text).toContain('from 800 ms to 120 ms');
    expect(text).toContain('Led a team of 5 on the main order service; handled 1,200,000 orders');
    expect(text).toContain('https://acme.dev/blog/integrations');
    // Name parts are masked wherever they appear, even in a company name (errs towards privacy).
    expect(text).toContain('[NAME] Logistics integration');
  });

  it('can keep profile links and addresses when asked', () => {
    const kept = redactPii(RESUME, { profileUrls: false, addresses: false });
    expect(kept.text).toContain('linkedin.com/in/priya-sharma-123');
    expect(kept.text).toContain('HSR Layout');
    expect(kept.counts.NAME).toBe(0);
  });

  it('handles names in other scripts and ignores very short name parts', () => {
    const r = redactPii('प्रिया शर्मा ने API बनाया। Al Li wrote it.', {
      names: ['प्रिया शर्मा', 'Al Li'],
    });
    expect(r.text).toBe('[NAME] ने API बनाया। [NAME] wrote it.');
  });

  it('does not treat ordinary numbers as phone numbers', () => {
    const r = redactPii('Revenue grew 1234567890 rupees? No: ids 5123456789012, year 2024, v1.2.3.');
    // A bare 10-digit number starting 1-5 is not an Indian mobile; 13 digits is not a phone.
    expect(r.counts.PHONE).toBe(0);
  });

  it('returns the text unchanged when there is nothing to mask', () => {
    const plain = 'Designed an idempotent payments API with cursor pagination.';
    expect(redactPii(plain)).toEqual({
      text: plain,
      counts: { EMAIL: 0, PHONE: 0, PROFILE_URL: 0, ADDRESS: 0, NAME: 0 },
    });
  });
});
