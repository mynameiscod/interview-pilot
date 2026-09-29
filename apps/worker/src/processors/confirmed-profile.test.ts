import type { JdStructured, ResumeStructured } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { jdRevisionText, resumeRevisionText, withRevision } from './confirmed-profile.js';

const resume: ResumeStructured = {
  headline: 'Backend engineer',
  totalExperienceYears: 4,
  skills: [
    { name: 'Node.js', level: 'STRONG', evidence: null },
    { name: 'Kafka', level: null, evidence: null },
  ],
  experience: [
    {
      title: 'Software Engineer',
      organization: 'Acme Payments',
      start: '2021-08',
      end: null,
      current: true,
      highlights: ['Built the payments ledger'],
    },
  ],
  projects: [{ name: 'Ledger', summary: null, technologies: ['PostgreSQL'] }],
  education: [{ qualification: 'B.Tech', institution: 'JNTU', year: 2020 }],
  certifications: [],
};

const jd: JdStructured = {
  title: 'Senior Backend Engineer',
  seniority: 'SENIOR',
  companyName: null,
  location: null,
  employmentType: null,
  domain: null,
  experienceYears: { min: 5, max: null },
  responsibilities: ['Own the payments platform'],
  skills: [
    { name: 'Go', importance: 'MUST' },
    { name: 'Kafka', importance: 'NICE' },
  ],
  qualifications: [],
};

describe('candidate revisions as prompt text', () => {
  it('lists the corrected resume facts', () => {
    expect(resumeRevisionText(resume)).toBe(
      [
        'Headline: Backend engineer',
        'Total experience: 4 years',
        'Skills: Node.js, Kafka',
        'Experience: Software Engineer at Acme Payments (2021-08 to present)',
        '  - Built the payments ledger',
        'Project: Ledger [PostgreSQL]',
        'Education: B.Tech, JNTU, 2020',
      ].join('\n'),
    );
  });

  it('lists the corrected job requirements', () => {
    expect(jdRevisionText(jd)).toBe(
      [
        'Title: Senior Backend Engineer',
        'Seniority: SENIOR',
        'Experience: 5 to ? years',
        'Must-have skills: Go',
        'Nice-to-have skills: Kafka',
        'Responsibility: Own the payments platform',
      ].join('\n'),
    );
  });

  it('puts the revision first and keeps within the character budget', () => {
    expect(withRevision(null, 'raw text', 4)).toBe('raw ');
    const text = withRevision('Skills: Go', 'x'.repeat(500), 200);
    expect(text.startsWith('Corrections confirmed by the candidate')).toBe(true);
    expect(text).toContain('Skills: Go');
    expect(text.length).toBeLessThanOrEqual(200);
    expect(withRevision('Skills: Go', '', 200)).not.toContain('\n\n');
  });
});
