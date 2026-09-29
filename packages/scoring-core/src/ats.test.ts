import { ResumeMatchReport, type JdStructured, type ResumeStructured } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import {
  bandFor,
  candidateYears,
  canonicalSkill,
  scoreResumeMatch,
  skillsInText,
  yearsInText,
  type MatchJdInput,
  type MatchResumeInput,
} from './ats.js';

const NOW = new Date('2026-09-01T00:00:00Z');

const RESUME_TEXT = `Summary
Backend engineer with 4 years building payment APIs.
Contact: asha@example.com
Skills
JS, Postgres, k8s, Docker, RESTful APIs
Experience
Acme Payments, Software Engineer, 2022 - present
Built microservices on AWS.
Education
B.Tech Computer Science, 2020`;

const structured: ResumeStructured = {
  headline: 'Backend engineer',
  totalExperienceYears: 4,
  skills: ['JS', 'Postgres', 'k8s', 'Docker'].map((name) => ({
    name,
    level: null,
    evidence: null,
  })),
  experience: [
    {
      title: 'Software Engineer',
      organization: 'Acme Payments',
      start: '2022-06',
      end: null,
      current: true,
      highlights: ['Built microservices on AWS.'],
    },
  ],
  projects: [],
  education: [{ qualification: 'B.Tech Computer Science', institution: null, year: 2020 }],
  certifications: [],
};

const layout = {
  pages: 1,
  words: 400,
  tablesSuspected: false,
  columnsSuspected: false,
  imageOnly: false,
};

const resume = (over: Partial<MatchResumeInput> = {}): MatchResumeInput => ({
  text: RESUME_TEXT,
  structured,
  layout,
  edited: false,
  ...over,
});

const jdStructured = (over: Partial<JdStructured> = {}): JdStructured => ({
  title: 'Backend Engineer',
  seniority: 'MID',
  companyName: null,
  location: null,
  employmentType: null,
  domain: null,
  experienceYears: { min: 3, max: 6 },
  responsibilities: [],
  skills: [
    { name: 'JavaScript', importance: 'MUST' },
    { name: 'PostgreSQL', importance: 'MUST' },
    { name: 'Kubernetes', importance: 'MUST' },
    { name: 'REST API', importance: 'MUST' },
    { name: 'Kafka', importance: 'NICE' },
  ],
  qualifications: [],
  ...over,
});

const jd = (over: Partial<JdStructured> = {}, text = 'Backend role'): MatchJdInput => ({
  text,
  structured: jdStructured(over),
  edited: false,
});

describe('skill aliases', () => {
  it('maps common spellings to one skill', () => {
    expect(canonicalSkill('K8s')).toBe('kubernetes');
    expect(canonicalSkill('Postgres')).toBe(canonicalSkill('PostgreSQL'));
    expect(canonicalSkill('NodeJS')).toBe('node.js');
    expect(canonicalSkill('Golang')).toBe(canonicalSkill('Go'));
    expect(canonicalSkill('AWS (EC2, S3)')).toBe('aws');
    expect(canonicalSkill('Some Niche Tool')).toBe('some niche tool');
  });

  it('finds known skills in unstructured JD text without false friends', () => {
    expect(skillsInText('We use Node.js, React and PostgreSQL on AWS. C++ is a plus.')).toEqual(
      expect.arrayContaining(['node.js', 'react', 'postgresql', 'aws', 'c++']),
    );
    // "JavaScript" is not Java; "the rest of the team" is not REST; "go-live" is not Go.
    const found = skillsInText('JavaScript for the rest of the team before go-live');
    expect(found).toContain('javascript');
    expect(found).not.toContain('java');
    expect(found).not.toContain('rest api');
    expect(found).not.toContain('golang');
  });
});

describe('scoreResumeMatch', () => {
  it('counts synonyms as matches and explains every point', () => {
    const report = scoreResumeMatch(resume(), jd(), NOW);
    expect(ResumeMatchReport.safeParse(report).success).toBe(true);
    expect(report.skills.mustHave).toEqual([
      { skill: 'JavaScript', matched: true, matchedAs: 'JS', foundIn: 'SKILLS' },
      { skill: 'PostgreSQL', matched: true, matchedAs: 'Postgres', foundIn: 'SKILLS' },
      { skill: 'Kubernetes', matched: true, matchedAs: 'k8s', foundIn: 'SKILLS' },
      { skill: 'REST API', matched: true, matchedAs: 'restful apis', foundIn: 'TEXT' },
    ]);
    expect(report.skills.niceToHave).toEqual([
      { skill: 'Kafka', matched: false, matchedAs: null, foundIn: null },
    ]);
    // Must-haves weigh 3, nice-to-haves 1: 12 of 13 skill weight.
    expect(report.components.find((c) => c.key === 'SKILLS')!.score).toBeCloseTo((50 * 12) / 13, 1);
    expect(report.reasons.filter((r) => r.code === 'SYNONYM_MATCHED')).toHaveLength(4);
    expect(report.reasons).toContainEqual(
      expect.objectContaining({
        code: 'NICE_TO_HAVE_MISSING',
        params: { skill: 'Kafka', worth: 3.8 },
      }),
    );
    expect(report.experience).toMatchObject({
      fit: 'MEETS',
      candidateYears: 4,
      requiredMinYears: 3,
    });
    expect(report.sections.every((s) => s.present)).toBe(true);
    expect(report.formatting.every((f) => !f.flagged)).toBe(true);
    // 46.2 + 20 + 15 + 15 = 96.2 of 100.
    expect(report.score).toBe(96);
    expect(report.band).toBe('STRONG');
    // The reasons add up to the score (components are reported separately too).
    const total = report.components.reduce((s, c) => s + c.score, 0);
    expect(Math.round(total)).toBe(96);
  });

  it('weighs a missing must-have three times a missing nice-to-have', () => {
    const missingMust = scoreResumeMatch(
      resume(),
      jd({
        skills: [
          { name: 'Go', importance: 'MUST' },
          { name: 'Docker', importance: 'NICE' },
        ],
      }),
      NOW,
    );
    const missingNice = scoreResumeMatch(
      resume(),
      jd({
        skills: [
          { name: 'Docker', importance: 'MUST' },
          { name: 'Go', importance: 'NICE' },
        ],
      }),
      NOW,
    );
    expect(missingMust.components[0]!.score).toBe(12.5);
    expect(missingNice.components[0]!.score).toBe(37.5);
    expect(missingMust.score).toBeLessThan(missingNice.score);
  });

  it('scores seniority and years of experience', () => {
    const senior = scoreResumeMatch(
      resume(),
      jd({ seniority: 'SENIOR', experienceYears: null }),
      NOW,
    );
    // No stated years: SENIOR implies 5+; 4 of 5 years earns 16 of 20.
    expect(senior.experience).toMatchObject({ fit: 'BELOW', requiredMinYears: 5 });
    expect(senior.components.find((c) => c.key === 'EXPERIENCE')!.score).toBe(16);
    expect(senior.reasons).toContainEqual(
      expect.objectContaining({
        code: 'EXPERIENCE_BELOW',
        params: { years: 4, required: 5, gap: 1 },
      }),
    );

    const junior = scoreResumeMatch(
      resume({ structured: { ...structured, totalExperienceYears: 12 } }),
      jd({ seniority: 'JUNIOR', experienceYears: null }),
      NOW,
    );
    expect(junior.experience.fit).toBe('ABOVE');

    // Years from the JD text when the parse has none.
    const fromText = scoreResumeMatch(
      resume(),
      jd({ seniority: null, experienceYears: null }, 'Minimum 6 years of experience in Java.'),
      NOW,
    );
    expect(fromText.experience).toMatchObject({ requiredMinYears: 6, fit: 'BELOW' });

    const unknown = scoreResumeMatch(
      resume({ structured: null }),
      jd({ seniority: null, experienceYears: null }),
      NOW,
    );
    expect(unknown.experience.fit).toBe('UNKNOWN');
    expect(unknown.components.find((c) => c.key === 'EXPERIENCE')!.score).toBe(10);
  });

  it('flags missing sections and formatting risks', () => {
    const bare = scoreResumeMatch(
      resume({
        text: 'Worked on things.',
        structured: null,
        layout: { ...layout, pages: 5, words: 2400, tablesSuspected: true, columnsSuspected: true },
      }),
      jd(),
      NOW,
    );
    expect(bare.sections.filter((s) => !s.present).map((s) => s.key)).toEqual([
      'CONTACT',
      'SUMMARY',
      'SKILLS',
      'EXPERIENCE_DATES',
      'EDUCATION',
    ]);
    expect(bare.formatting.filter((f) => f.flagged).map((f) => f.key)).toEqual([
      'TABLES',
      'COLUMNS',
      'TOO_LONG',
    ]);
    expect(bare.components.find((c) => c.key === 'FORMATTING')!.score).toBe(4);
    expect(bare.band).toBe('WEAK');

    const scan = scoreResumeMatch(resume({ layout: { ...layout, imageOnly: true } }), jd(), NOW);
    expect(scan.reasons).toContainEqual(
      expect.objectContaining({ code: 'FORMAT_RISK', points: -7, params: { risk: 'IMAGE_ONLY' } }),
    );
  });

  it('falls back to known skills in the JD text, and rescales without any', () => {
    const unstructured = scoreResumeMatch(
      resume(),
      {
        text: 'We need Kubernetes, Kafka and PostgreSQL experience.',
        structured: null,
        edited: false,
      },
      NOW,
    );
    expect(unstructured.skills.mustHave.map((m) => [m.skill, m.matched])).toEqual([
      ['postgresql', true],
      ['kafka', false],
      ['kubernetes', true],
    ]);
    const noSkills = scoreResumeMatch(
      resume(),
      { text: 'A friendly team.', structured: null, edited: true },
      NOW,
    );
    expect(noSkills.components.map((c) => c.key)).toEqual(['EXPERIENCE', 'SECTIONS', 'FORMATTING']);
    expect(noSkills.reasons[0]!.code).toBe('NO_JD_SKILLS');
    expect(noSkills.usedEdits).toEqual({ resume: false, jd: true });
  });

  it('is deterministic', () => {
    expect(scoreResumeMatch(resume(), jd(), NOW)).toEqual(scoreResumeMatch(resume(), jd(), NOW));
  });
});

describe('helpers', () => {
  it('reads years from JD text', () => {
    expect(yearsInText('3-5 years of experience')).toEqual({ min: 3, max: 5 });
    expect(yearsInText('at least 4+ yrs experience')).toEqual({ min: 4, max: null });
    expect(yearsInText('No experience needed')).toBeNull();
  });

  it('derives years from dated roles', () => {
    const years = candidateYears(
      {
        ...structured,
        totalExperienceYears: null,
        experience: [
          { ...structured.experience[0]!, start: '2020-01', end: '2021-12', current: false },
          { ...structured.experience[0]!, start: '2021-06', end: null, current: true },
        ],
      },
      new Date('2023-12-15T00:00:00Z'),
    );
    expect(years).toBe(4);
  });

  it('bands scores', () => {
    expect([85, 70, 50, 20].map(bandFor)).toEqual(['STRONG', 'GOOD', 'FAIR', 'WEAK']);
  });
});
