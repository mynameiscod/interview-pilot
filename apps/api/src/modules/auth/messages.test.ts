import type { UiLocale } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { otpEmail, otpSms } from './messages.js';

const LOCALES: UiLocale[] = ['en', 'hi', 'te'];

describe('otpEmail', () => {
  it.each(LOCALES)('renders the code, minutes and product name in %s', (lang) => {
    const msg = otpEmail('asha@example.com', '482913', 7, 'candidate', lang);
    expect(msg.to).toBe('asha@example.com');
    for (const part of [msg.subject, msg.text, msg.html!]) {
      expect(part).toContain('482913');
      expect(part).toContain('CareerPilot Interview');
    }
    expect(msg.text).toContain('7');
    expect(msg.html).toContain('7');
    expect(msg.text).toContain('CodeBegun');
    expect(msg.html).toContain(`lang="${lang}"`);
  });

  it('localises Hindi and Telugu copy', () => {
    const en = otpEmail('a@b.co', '111111', 5, 'candidate', 'en');
    const hi = otpEmail('a@b.co', '111111', 5, 'candidate', 'hi');
    const te = otpEmail('a@b.co', '111111', 5, 'candidate', 'te');
    expect(hi.subject).not.toBe(en.subject);
    expect(te.subject).not.toBe(en.subject);
    expect(hi.text).not.toBe(en.text);
    expect(te.text).not.toBe(en.text);
    expect(hi.text).toMatch(/[ऀ-ॿ]/); // Devanagari
    expect(te.text).toMatch(/[ఀ-౿]/); // Telugu
  });

  it('uses the admin product name for admins', () => {
    expect(otpEmail('a@b.co', '111111', 5, 'admin', 'hi').subject).toContain(
      'CareerPilot Interview Admin',
    );
  });

  it('falls back to English for an unknown or missing language', () => {
    const en = otpEmail('a@b.co', '111111', 5, 'candidate', 'en');
    expect(otpEmail('a@b.co', '111111', 5, 'candidate')).toEqual(en);
    expect(otpEmail('a@b.co', '111111', 5, 'candidate', 'fr' as UiLocale)).toEqual(en);
  });
});

describe('otpSms', () => {
  it.each(LOCALES)('renders the code and minutes in %s and stays short', (lang) => {
    const text = otpSms('482913', 5, 'candidate', lang);
    expect(text).toContain('482913');
    expect(text).toContain('5');
    expect(text).toContain('CareerPilot Interview');
    expect(text.length).toBeLessThanOrEqual(160);
  });

  it('localises Hindi and Telugu and falls back to English', () => {
    const en = otpSms('111111', 5, 'candidate', 'en');
    expect(otpSms('111111', 5, 'candidate', 'hi')).not.toBe(en);
    expect(otpSms('111111', 5, 'candidate', 'te')).not.toBe(en);
    expect(otpSms('111111', 5, 'candidate', 'xx' as UiLocale)).toBe(en);
  });
});
