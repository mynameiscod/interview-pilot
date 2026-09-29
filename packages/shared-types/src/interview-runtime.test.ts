import { describe, expect, it } from 'vitest';
import {
  AssessTurnAi,
  resolveInterviewLanguage,
  StartInterviewBody,
  TurnEvalSufficiency,
} from './interview-runtime.js';

describe('resolveInterviewLanguage', () => {
  it('keeps an explicit language', () => {
    expect(resolveInterviewLanguage('hi', ['te'])).toBe('hi');
    expect(resolveInterviewLanguage('te')).toBe('te');
  });

  it('resolves auto from the profile, then the UI locale, before English', () => {
    expect(resolveInterviewLanguage('auto', ['te', 'hi'])).toBe('te');
    expect(resolveInterviewLanguage('auto', ['auto', 'hi'])).toBe('hi');
    expect(resolveInterviewLanguage('auto', [null, undefined, 'te'])).toBe('te');
    expect(resolveInterviewLanguage('auto', ['auto', 'fr'])).toBe('en');
    expect(resolveInterviewLanguage('auto')).toBe('en');
  });

  it('accepts only UI locales at start', () => {
    expect(StartInterviewBody.parse({})).toEqual({});
    expect(StartInterviewBody.parse({ uiLocale: 'te' })).toEqual({ uiLocale: 'te' });
    expect(StartInterviewBody.safeParse({ uiLocale: 'fr' }).success).toBe(false);
  });
});

describe('turn assessments', () => {
  it('records an unavailable assessment distinctly, but the model can never return it', () => {
    expect(TurnEvalSufficiency.options).toContain('UNASSESSED');
    expect(
      AssessTurnAi.safeParse({
        sufficiency: 'UNASSESSED',
        followUpNeeded: false,
        followUpAngle: null,
        evidence: [],
        notes: null,
      }).success,
    ).toBe(false);
  });
});
