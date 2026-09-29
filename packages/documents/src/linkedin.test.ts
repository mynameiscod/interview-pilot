import { ResumeStructured } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { extractDocumentText } from './extract.js';
import { detectLinkedInProfile, experienceYears, parseLinkedInProfile } from './linkedin.js';
import {
  buildLinkedInProfilePdf,
  buildPdf,
  LINKEDIN_PASTED_TEXT,
  SAMPLE_RESUME_LINES,
} from './testing.js';

const NOW = new Date('2024-10-15T00:00:00Z');

describe('LinkedIn "Save to PDF" export', () => {
  it('is read column by column and recognised', async () => {
    const extracted = await extractDocumentText(buildLinkedInProfilePdf());
    expect(extracted.layout).toMatchObject({ columnsSuspected: true, pages: 1, imageOnly: false });
    // The sidebar comes out whole before the main column.
    const text = extracted.text;
    expect(text.indexOf('AWS Certified Developer')).toBeLessThan(text.indexOf('Priya Demo'));
    expect(detectLinkedInProfile(text)).toBe('PDF_EXPORT');
  });

  it('parses summary, grouped roles, education and skills without contact details', async () => {
    const { text } = await extractDocumentText(buildLinkedInProfilePdf());
    const profile = parseLinkedInProfile(text, NOW)!;
    expect(ResumeStructured.safeParse(profile.structured).success).toBe(true);
    expect(profile.summary).toBe(
      'Backend engineer who builds reliable payment systems with Node.js and PostgreSQL.',
    );
    const s = profile.structured;
    expect(s.headline).toBe('Senior Backend Engineer at Acme Payments');
    expect(s.skills.map((k) => k.name)).toEqual(['Node.js', 'PostgreSQL', 'Kubernetes']);
    expect(s.certifications).toEqual(['AWS Certified Developer']);
    expect(s.experience).toEqual([
      {
        title: 'Senior Software Engineer',
        organization: 'Acme Payments',
        start: '2023-01',
        end: null,
        current: true,
        highlights: [
          'Designed an idempotent payments ledger handling 2M transactions a day.',
          'Reduced p95 latency by 40% by moving hot reads to Redis.',
        ],
      },
      {
        title: 'Software Engineer',
        organization: 'Acme Payments',
        start: '2021-08',
        end: '2022-12',
        current: false,
        highlights: ['Built REST APIs in TypeScript for merchant onboarding.'],
      },
      {
        title: 'Software Engineering Intern',
        organization: 'Globex Labs',
        start: '2021-01',
        end: '2021-06',
        current: false,
        highlights: ['Wrote integration tests for the billing service.'],
      },
    ]);
    expect(s.education).toEqual([
      {
        qualification: 'Bachelor of Technology - BTech, Computer Science',
        institution: 'JNTU Hyderabad',
        year: 2021,
      },
    ]);
    // Jan-Jun 2021 plus Aug 2021 to Oct 2024: 45 months.
    expect(s.totalExperienceYears).toBe(3.8);
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toMatch(/example\.com|linkedin\.com|Priya Demo/);
  });
});

describe('pasted LinkedIn profile text', () => {
  it('is recognised and parsed in web order', () => {
    expect(detectLinkedInProfile(LINKEDIN_PASTED_TEXT)).toBe('PASTED');
    const profile = parseLinkedInProfile(LINKEDIN_PASTED_TEXT, NOW)!;
    expect(profile.summary).toBe('Backend engineer who builds reliable payment systems.');
    const s = profile.structured;
    expect(s.experience.map((e) => [e.title, e.organization, e.start, e.end])).toEqual([
      ['Senior Software Engineer', 'Acme Payments', '2023-01', null],
      ['Software Engineer', 'Acme Payments', '2021-08', '2022-12'],
    ]);
    expect(s.experience[0]!.highlights).toEqual([
      'Designed an idempotent payments ledger handling 2M transactions a day.',
    ]);
    expect(s.education).toEqual([
      {
        qualification: 'Bachelor of Technology - BTech, Computer Science',
        institution: 'JNTU Hyderabad',
        year: 2021,
      },
    ]);
    // Endorsement and "show all" lines are not skills.
    expect(s.skills.map((k) => k.name)).toEqual(['Node.js', 'PostgreSQL']);
  });
});

describe('ordinary resumes', () => {
  it('are not mistaken for LinkedIn profiles', async () => {
    const { text } = await extractDocumentText(buildPdf([SAMPLE_RESUME_LINES]));
    expect(detectLinkedInProfile(text)).toBeNull();
    expect(parseLinkedInProfile(text)).toBeNull();
    const plain = [
      'Summary',
      'Engineer.',
      'Experience',
      'Acme Corp',
      'Developer',
      '2020 - 2022',
      'Education',
      'B.Tech 2019',
    ].join('\n');
    expect(detectLinkedInProfile(plain)).toBeNull();
  });
});

describe('experienceYears', () => {
  it('counts overlapping roles once and open roles up to now', () => {
    expect(
      experienceYears(
        [
          { start: '2020-01', end: '2021-12', current: false },
          { start: '2021-06', end: null, current: true },
        ],
        new Date('2023-12-31T00:00:00Z'),
      ),
    ).toBe(4);
    expect(experienceYears([{ start: null, end: null, current: false }], NOW)).toBeNull();
    // Year-only dates cover the whole year.
    expect(experienceYears([{ start: '2019', end: '2019', current: false }], NOW)).toBe(1);
  });
});
