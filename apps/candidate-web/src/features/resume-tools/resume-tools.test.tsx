import type {
  ResumeMatchReport,
  ResumeStructured,
  ResumeTailoringSummary,
  TailoringSuggestions,
} from '@cbi/shared-types';
import { fail, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeApiWithUploads } from '../../test/fake-api';
import { makeInterview, makeJobTarget, makeResume } from '../../test/interview-fixtures';
import { renderRoute } from '../../test/render';
import { initialWizardState, saveWizardState } from '../interviews/wizard/wizard-state';
import { tailoredDraft } from './tailored-draft';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };

const STRUCTURED: ResumeStructured = {
  headline: 'Backend engineer',
  totalExperienceYears: 4,
  skills: [
    { name: 'Node.js', level: null, evidence: null },
    { name: 'k8s', level: null, evidence: null },
  ],
  experience: [
    {
      title: 'Software Engineer',
      organization: 'Acme Payments',
      start: '2022-06',
      end: null,
      current: true,
      highlights: ['Built the payments ledger.'],
    },
  ],
  projects: [],
  education: [{ qualification: 'B.Tech', institution: 'JNTU', year: 2020 }],
  certifications: [],
};

const REPORT: ResumeMatchReport = {
  score: 82,
  band: 'STRONG',
  components: [
    { key: 'SKILLS', score: 37.5, max: 50 },
    { key: 'EXPERIENCE', score: 20, max: 20 },
    { key: 'SECTIONS', score: 12, max: 15 },
    { key: 'FORMATTING', score: 11, max: 15 },
  ],
  skills: {
    mustHave: [
      { skill: 'Kubernetes', matched: true, matchedAs: 'k8s', foundIn: 'SKILLS' },
      { skill: 'Kafka', matched: false, matchedAs: null, foundIn: null },
    ],
    niceToHave: [],
  },
  experience: {
    requiredMinYears: 3,
    requiredMaxYears: null,
    candidateYears: 4,
    seniority: 'MID',
    fit: 'MEETS',
  },
  sections: [
    { key: 'CONTACT', present: true },
    { key: 'SUMMARY', present: false },
    { key: 'SKILLS', present: true },
    { key: 'EXPERIENCE_DATES', present: true },
    { key: 'EDUCATION', present: true },
  ],
  formatting: [
    { key: 'TABLES', flagged: true },
    { key: 'COLUMNS', flagged: false },
    { key: 'IMAGE_ONLY', flagged: false },
    { key: 'TOO_LONG', flagged: false },
    { key: 'TOO_SHORT', flagged: false },
  ],
  reasons: [
    {
      code: 'MUST_HAVE_MISSING',
      component: 'SKILLS',
      impact: 'NEGATIVE',
      points: 0,
      params: { skill: 'Kafka', worth: 25 },
    },
    {
      code: 'SYNONYM_MATCHED',
      component: 'SKILLS',
      impact: 'INFO',
      points: 0,
      params: { skill: 'Kubernetes', as: 'k8s' },
    },
    {
      code: 'SECTION_MISSING',
      component: 'SECTIONS',
      impact: 'NEGATIVE',
      points: 0,
      params: { section: 'SUMMARY' },
    },
    {
      code: 'FORMAT_RISK',
      component: 'FORMATTING',
      impact: 'NEGATIVE',
      points: -4,
      params: { risk: 'TABLES' },
    },
  ],
  usedEdits: { resume: false, jd: false },
  computedAt: '2026-09-20T10:00:00.000Z',
};

const SUGGESTIONS: TailoringSuggestions = {
  summary: 'Backend engineer with 4 years of experience in Node.js.',
  bullets: [
    {
      original: 'Built the payments ledger.',
      rewritten: 'Built an idempotent payments ledger that cut failed settlements by [X%].',
      keywords: ['payments'],
      placeholders: ['[X%]'],
    },
  ],
  missingKeywords: [{ keyword: 'Kafka', guidance: '', mustHave: true }],
  guardNotes: [{ note: 'UNKNOWN_EMPLOYER', count: 1 }],
  source: 'AI',
};

const tailoring = (over: Partial<ResumeTailoringSummary>): ResumeTailoringSummary => ({
  id: 't1',
  resumeId: 'res1',
  jobTargetId: 'job1',
  status: 'PENDING',
  suggestions: null,
  failureCode: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  completedAt: null,
  ...over,
});

const readyJob = makeJobTarget({
  extraction: makeResume().extraction,
  structured: {
    title: 'Backend Engineer',
    seniority: 'MID',
    companyName: null,
    location: null,
    employmentType: null,
    domain: null,
    experienceYears: { min: 3, max: null },
    responsibilities: ['Own the payments platform'],
    skills: [
      { name: 'Kubernetes', importance: 'MUST' },
      { name: 'Kafka', importance: 'MUST' },
    ],
    qualifications: [],
  },
});

describe('resume check page', () => {
  it('shows the explained match score, lets me correct the resume and get honest suggestions', async () => {
    let resume = makeResume({ structured: STRUCTURED });
    let polls = 0;
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok([resume]),
      'GET /jobs': () => ok([readyJob]),
      'POST /resume-tools/match': () => ok(REPORT),
      'PUT /resumes/res1/structured': (body) => {
        resume = {
          ...resume,
          edited: body as ResumeStructured,
          editedAt: '2026-09-21T10:00:00.000Z',
        };
        return ok(resume);
      },
      'POST /resume-tools/tailorings': () => ({ status: 202, body: { data: tailoring({}) } }),
      'GET /resume-tools/tailorings/t1': () =>
        ok(
          ++polls < 2
            ? tailoring({})
            : tailoring({ status: 'READY', suggestions: SUGGESTIONS, completedAt: 'x' }),
        ),
    });
    await renderRoute('/app/resume-check', { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Resume check' })).toBeInTheDocument();
    const match = await screen.findByRole('region', { name: 'Resume match' });
    expect(await within(match).findByText('82')).toBeInTheDocument();
    expect(within(match).getByText('Strong match')).toBeInTheDocument();
    expect(within(match).getByText('(as “k8s”)')).toBeInTheDocument();
    expect(within(match).getAllByText(/Tables found/).length).toBeGreaterThan(0);
    expect(
      within(match).getByText('Must-have skill not found: Kafka (worth 25 points).'),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /resume-tools/match')!.body).toEqual({
      resumeId: 'res1',
      jobTargetId: 'job1',
    });

    // Correct the parsed resume: add a skill chip and save it as my revision.
    const preview = screen.getByRole('region', { name: /What we read from your resume/ });
    await user.click(within(preview).getByRole('button', { name: 'Edit' }));
    await user.type(within(preview).getByLabelText('Skills'), 'Kafka{Enter}');
    await user.click(within(preview).getByRole('button', { name: 'Remove k8s' }));
    await user.click(within(preview).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.key === 'PUT /resumes/res1/structured')).toBe(true),
    );
    const saved = api.calls.find((c) => c.key === 'PUT /resumes/res1/structured')!
      .body as ResumeStructured;
    expect(saved.skills.map((s) => s.name)).toEqual(['Node.js', 'Kafka']);
    expect(saved.experience[0]!.organization).toBe('Acme Payments');
    expect(await within(preview).findByText('Edited by you')).toBeInTheDocument();

    // Tailoring: a visible honesty note, suggestions to copy, never applied automatically.
    const tailor = screen.getByRole('region', { name: 'Tailoring suggestions' });
    expect(within(tailor).getByRole('note')).toHaveTextContent(/We never change your resume/);
    await user.click(within(tailor).getByRole('button', { name: 'Get suggestions for this job' }));
    expect(
      await within(tailor).findByText(
        'Built an idempotent payments ledger that cut failed settlements by [X%].',
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      within(tailor).getByText(/Fill in \[X%\] only if you know the real value/),
    ).toBeInTheDocument();
    expect(
      within(tailor).getByText(/Add this only if you have really used it/),
    ).toBeInTheDocument();
    expect(
      within(tailor).getByText(/1 suggestion that named an employer or tool not in your resume/),
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'PUT /resumes/res1/structured')).toBe(true);
    expect(api.calls.filter((c) => c.key.startsWith('PUT')).length).toBe(1);
  });

  it('explains when there is nothing to compare yet', async () => {
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok([]),
      'GET /jobs': () => ok([]),
    });
    await renderRoute('/app/resume-check', { api });
    expect(
      await screen.findByRole('link', { name: 'Add a resume and job description' }),
    ).toHaveAttribute('href', '/app/new');
  });

  it('says so while an input is still being read', async () => {
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok([makeResume({ structured: STRUCTURED })]),
      'GET /jobs': () => ok([readyJob]),
      'POST /resume-tools/match': () => fail(409, 'INVALID_STATE'),
    });
    await renderRoute('/app/resume-check', { api });
    expect(await screen.findByText(/still being read/)).toBeInTheDocument();
  });
});

describe('analysis step', () => {
  it('shows the editable job description, the resume match panel and tailoring', async () => {
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /interviews/int1': () => ok(makeInterview()),
      'GET /jobs/job1': () => ok(readyJob),
      'GET /resumes': () => ok([makeResume({ structured: STRUCTURED })]),
      'POST /resume-tools/match': () => ok(REPORT),
    });
    await renderRoute('/app/interviews/int1/analysis', { api });
    const match = await screen.findByRole('region', { name: 'Resume match' });
    expect(await within(match).findByText('82')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /What we read from the job description/ }),
    ).toHaveTextContent('Kafka');
    expect(screen.getByRole('region', { name: 'Tailoring suggestions' })).toBeInTheDocument();
  });
});

describe('wizard resume step', () => {
  it('accepts pasted LinkedIn profile text and shows what was read, with a LinkedIn badge', async () => {
    sessionStorage.clear();
    saveWizardState({ ...initialWizardState(), step: 1 });
    let resumes: ReturnType<typeof makeResume>[] = [];
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok(resumes),
      'POST /resumes/text': () => {
        resumes = [
          makeResume({
            id: 'res2',
            originalName: 'Pasted profile.txt',
            source: 'PASTE',
            format: 'LINKEDIN',
            structured: STRUCTURED,
          }),
        ];
        return { status: 201, body: { data: resumes[0] } };
      },
    });
    await renderRoute('/app/new', { api });
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();
    expect(screen.getByText(/Save to PDF/)).toBeInTheDocument();

    await user.click(screen.getByText('Or paste your resume or LinkedIn profile text'));
    await user.click(screen.getByLabelText('Resume or profile text'));
    await user.paste('Too short');
    await user.click(screen.getByRole('button', { name: 'Use this text' }));
    expect(await screen.findByText(/Paste at least 200 characters/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Resume or profile text'));
    await user.paste(' Experience '.repeat(30));
    await user.click(screen.getByRole('button', { name: 'Use this text' }));
    expect(await screen.findByText('LinkedIn')).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /resumes/text')!.body).toEqual({
      text: expect.stringContaining('Too short'),
    });
    expect(
      await screen.findByRole('region', { name: /What we read from your resume/ }),
    ).toHaveTextContent('From your LinkedIn profile');
  });
});

describe('tailored draft export', () => {
  it('puts the rewrites in place of the bullets they rewrite and adds nothing else', () => {
    const labels = {
      notice: 'DRAFT',
      summary: 'Summary',
      skills: 'Skills',
      experience: 'Experience',
      projects: 'Projects',
      education: 'Education',
      certifications: 'Certifications',
      present: 'present',
    };
    const { text, markdown } = tailoredDraft(STRUCTURED, SUGGESTIONS, labels);
    expect(markdown).toContain('> DRAFT');
    expect(markdown).toContain('**Software Engineer, Acme Payments (2022-06 - present)**');
    expect(markdown).toContain(
      '- Built an idempotent payments ledger that cut failed settlements by [X%].',
    );
    expect(markdown).not.toContain('- Built the payments ledger.');
    expect(text).toContain('SUMMARY\nBackend engineer with 4 years of experience in Node.js.');
    expect(text).toContain('- B.Tech, JNTU, 2020');
    expect(text).not.toMatch(/Kafka/);
  });
});
