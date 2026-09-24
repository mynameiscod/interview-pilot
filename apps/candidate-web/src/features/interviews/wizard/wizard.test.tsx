import type { ResumeSummary } from '@cbi/shared-types';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fail, makeSession, ok } from '@cbi/web-core/testing';
import { fakeApiWithUploads } from '../../../test/fake-api';
import {
  makeExtraction,
  makeInterview,
  makeJobTarget,
  makeResume,
} from '../../../test/interview-fixtures';
import { renderRoute } from '../../../test/render';
import { initialWizardState, saveWizardState } from './wizard-state';

const JD_TEXT =
  'We are hiring a Backend Developer to build Node.js services, design SQL schemas and review code.';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };

/** Opens the wizard directly on the job description step. */
function startAtJobStep() {
  saveWizardState({ ...initialWizardState(), step: 2 });
}

beforeEach(() => sessionStorage.clear());

describe('new interview wizard', () => {
  it('uploads a resume, pastes a JD, picks a role and starts the analysis', async () => {
    let resumes: ResumeSummary[] = [];
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok(resumes),
      'POST /resumes': () => {
        const resume = makeResume({
          originalName: 'cv.pdf',
          extraction: makeExtraction({ status: 'PENDING', completedAt: null }),
        });
        resumes = [resume];
        return { status: 201, body: { data: resume } };
      },
      'GET /resumes/res1/status': () => ok(makeExtraction()),
      'GET /companies': () => ok([]),
      'GET /roles': () =>
        ok([{ id: 'role1', name: 'Backend Developer', slug: 'backend-developer' }]),
      'POST /jobs': () => ({ status: 201, body: { data: makeJobTarget() } }),
      'POST /interviews': () => ({
        status: 201,
        body: { data: makeInterview({ state: 'DRAFT', analysis: null }) },
      }),
      'POST /interviews/int1/analyze': () => ({
        status: 202,
        body: { data: makeInterview({ state: 'ROLE_ANALYSIS', analysis: null }) },
      }),
      'GET /interviews/int1': () => ok(makeInterview({ state: 'ROLE_ANALYSIS', analysis: null })),
    });
    const { router } = await renderRoute('/app/new', { api });
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Before you begin' })).toBeInTheDocument();
    expect(screen.getByText(/not used in scoring/)).toBeInTheDocument();
    const current = screen.getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('Start');
    await user.click(screen.getByRole('button', { name: "Let's begin" }));

    expect(await screen.findByRole('heading', { name: 'Add your resume' })).toBeInTheDocument();
    expect(screen.getByText('PDF, DOCX or TXT, up to 8 MB.')).toBeInTheDocument();
    await user.upload(
      screen.getByLabelText('Resume file'),
      new File(['%PDF-1.7 resume'], 'cv.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText('Your resume is ready.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'cv.pdf' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByRole('heading', { name: 'Add the job description' }),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText('Job description text'));
    await user.paste(JD_TEXT);
    expect(screen.getByText(`${JD_TEXT.length} / 60,000 characters`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Company and role' })).toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: 'Role' }), 'Backend');
    await user.click(await screen.findByRole('option', { name: 'Backend Developer' }));
    await user.click(screen.getByRole('button', { name: 'Analyse my interview' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/analysis'),
    );
    expect(
      await screen.findByRole('heading', { name: 'Analysing your interview' }),
    ).toBeInTheDocument();

    const body = (key: string) => api.calls.find((c) => c.key === key)?.body;
    expect(body('POST /resumes')).toEqual({ file: { name: 'cv.pdf' } });
    expect(body('POST /jobs')).toEqual({ source: 'PASTE', text: JD_TEXT, roleId: 'role1' });
    expect(body('POST /interviews')).toEqual({ jobTargetId: 'job1', resumeId: 'res1' });
    expect(api.calls.filter((c) => c.key === 'POST /interviews/int1/analyze')).toHaveLength(1);
  });

  it('rejects unsupported files before uploading them', async () => {
    const api = fakeApiWithUploads({ ...signedIn, 'GET /resumes': () => ok([]) });
    saveWizardState({ ...initialWizardState(), step: 1 });
    await renderRoute('/app/new', { api });
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(
      await screen.findByLabelText('Resume file'),
      new File(['x'], 'photo.png', { type: 'image/png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file type is not supported. Upload a PDF, DOCX or TXT file.',
    );
    expect(api.calls.some((c) => c.key === 'POST /resumes')).toBe(false);
  });

  it('explains a password-protected resume', async () => {
    const encrypted = makeResume({
      extraction: makeExtraction({ status: 'FAILED', errorCode: 'ENCRYPTED' }),
    });
    let resumes: ResumeSummary[] = [];
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /resumes': () => ok(resumes),
      'POST /resumes': () => {
        resumes = [encrypted];
        return { status: 201, body: { data: encrypted } };
      },
    });
    saveWizardState({ ...initialWizardState(), step: 1 });
    await renderRoute('/app/new', { api });
    const user = userEvent.setup();
    await user.upload(
      await screen.findByLabelText('Resume file'),
      new File(['%PDF'], 'locked.pdf', { type: 'application/pdf' }),
    );
    expect(
      await screen.findByText(
        'This file is password-protected. Remove the password and upload it again.',
      ),
    ).toBeInTheDocument();
  });

  it('offers to paste the text when a job link cannot be read', async () => {
    const api = fakeApiWithUploads({
      ...signedIn,
      'POST /jobs': () => ({
        status: 201,
        body: { data: makeJobTarget({ source: 'URL', url: 'https://jobs.example.com/1' }) },
      }),
      'GET /jobs/job1/status': () =>
        ok(makeExtraction({ status: 'FAILED', errorCode: 'FETCH_FAILED' })),
    });
    startAtJobStep();
    await renderRoute('/app/new', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Link' }));
    await user.type(screen.getByLabelText('Link to the job posting'), 'https://jobs.example.com/1');
    await user.click(screen.getByRole('button', { name: 'Read this page' }));

    expect(await screen.findByText('We could not read this page')).toBeInTheDocument();
    expect(
      screen.getByText(
        'We could not open this page. It may need a sign-in, or the site may be unavailable.',
      ),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /jobs')!.body).toEqual({
      source: 'URL',
      url: 'https://jobs.example.com/1',
    });

    await user.click(screen.getByRole('button', { name: 'Paste the text instead' }));
    expect(screen.getByRole('tab', { name: 'Paste' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByLabelText('Job description text')).toHaveFocus());
  });

  it('saves the chosen company and role on an uploaded JD before creating the interview', async () => {
    const uploaded = makeJobTarget({
      source: 'UPLOAD',
      originalName: 'jd.docx',
      extraction: makeExtraction(),
      structured: {
        title: 'Frontend Engineer',
        seniority: 'MID',
        companyName: 'Acme',
        location: null,
        employmentType: null,
        domain: null,
        experienceYears: null,
        responsibilities: [],
        skills: [],
        qualifications: [],
      },
    });
    const api = fakeApiWithUploads({
      ...signedIn,
      'POST /jobs/upload': () => ({ status: 201, body: { data: uploaded } }),
      'GET /jobs/job1/status': () => ok(makeExtraction()),
      'GET /jobs/job1': () => ok(uploaded),
      'GET /companies': () => ok([{ id: 'c1', name: 'Acme Labs', slug: 'acme-labs' }]),
      'GET /roles': () => ok([]),
      'PATCH /jobs/job1': (body) =>
        ok({ ...uploaded, company: { id: 'c1', name: 'Acme Labs' }, ...(body as object) }),
      'POST /interviews': () => ({
        status: 201,
        body: { data: makeInterview({ state: 'DRAFT', analysis: null, resumeId: null }) },
      }),
      'POST /interviews/int1/analyze': () => ({
        status: 202,
        body: { data: makeInterview({ state: 'ROLE_ANALYSIS', analysis: null }) },
      }),
      'GET /interviews/int1': () => ok(makeInterview({ state: 'ROLE_ANALYSIS', analysis: null })),
    });
    startAtJobStep();
    const { router } = await renderRoute('/app/new', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Upload' }));
    await user.upload(
      screen.getByLabelText('Job description file'),
      new File(['jd'], 'jd.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    expect(await screen.findByText('The job description is ready.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Prefilled from what was read from the JD.
    const company = await screen.findByRole('combobox', { name: 'Company (optional)' });
    await waitFor(() => expect(company).toHaveValue('Acme'));
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('Frontend Engineer');

    await user.clear(company);
    await user.type(company, 'Acme L');
    await user.click(await screen.findByRole('option', { name: 'Acme Labs' }));
    await user.click(screen.getByRole('button', { name: 'Analyse my interview' }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/analysis'),
    );
    const keys = api.calls.map((c) => c.key);
    expect(keys).not.toContain('POST /jobs');
    expect(keys.indexOf('PATCH /jobs/job1')).toBeGreaterThan(-1);
    expect(keys.indexOf('PATCH /jobs/job1')).toBeLessThan(keys.indexOf('POST /interviews'));
    expect(api.calls.find((c) => c.key === 'PATCH /jobs/job1')!.body).toEqual({
      companyId: 'c1',
      roleTitle: 'Frontend Engineer',
    });
    expect(api.calls.find((c) => c.key === 'POST /interviews')!.body).toEqual({
      jobTargetId: 'job1',
      resumeId: null,
    });
  });

  it('requires a pasted JD to be long enough', async () => {
    startAtJobStep();
    await renderRoute('/app/new', { api: fakeApiWithUploads(signedIn) });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Job description text'), 'Too short');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Paste at least 50 characters of the job description, or skip this step.',
    );
    expect(screen.getByLabelText('Job description text')).toHaveAttribute('aria-invalid', 'true');
  });

  it('requires a role when the JD is skipped and never duplicates inputs on retry', async () => {
    let analyzeCalls = 0;
    const api = fakeApiWithUploads({
      ...signedIn,
      'GET /roles': () => ok([]),
      'GET /companies': () => ok([]),
      'POST /jobs': () => ({
        status: 201,
        body: {
          data: makeJobTarget({
            source: 'ROLE_ONLY',
            roleTitle: 'Data Analyst',
            extraction: makeExtraction(),
          }),
        },
      }),
      'POST /interviews': () => ({
        status: 201,
        body: { data: makeInterview({ state: 'DRAFT', analysis: null, resumeId: null }) },
      }),
      'POST /interviews/int1/analyze': () =>
        ++analyzeCalls === 1
          ? fail(503, 'SERVICE_UNAVAILABLE')
          : {
              status: 202,
              body: { data: makeInterview({ state: 'ROLE_ANALYSIS', analysis: null }) },
            },
      'GET /interviews/int1': () => ok(makeInterview({ state: 'ROLE_ANALYSIS', analysis: null })),
    });
    startAtJobStep();
    const { router } = await renderRoute('/app/new', { api });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: "Skip — I don't have one" }));
    expect(await screen.findByRole('heading', { name: 'Company and role' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Analyse my interview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose or type the role you are preparing for.',
    );
    const role = screen.getByRole('combobox', { name: 'Role (required)' });
    expect(role).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls.some((c) => c.key === 'POST /jobs')).toBe(false);

    await user.type(role, 'Data Analyst');
    await user.click(await screen.findByRole('option', { name: 'Use “Data Analyst”' }));
    await user.click(screen.getByRole('button', { name: 'Analyse my interview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is busy right now. Please try again in a few minutes.',
    );

    await user.click(screen.getByRole('button', { name: 'Analyse my interview' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/app/interviews/int1/analysis'),
    );
    expect(api.calls.filter((c) => c.key === 'POST /jobs')).toHaveLength(1);
    expect(api.calls.filter((c) => c.key === 'POST /interviews')).toHaveLength(1);
    expect(api.calls.find((c) => c.key === 'POST /jobs')!.body).toEqual({
      source: 'ROLE_ONLY',
      roleTitle: 'Data Analyst',
    });
    expect(api.calls.find((c) => c.key === 'POST /interviews')!.body).toEqual({
      jobTargetId: 'job1',
      resumeId: null,
    });
  });

  it('restores progress after a page refresh', async () => {
    saveWizardState({ ...initialWizardState(), step: 2, jdText: JD_TEXT });
    await renderRoute('/app/new', { api: fakeApiWithUploads(signedIn) });
    expect(
      await screen.findByRole('heading', { name: 'Add the job description' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Job description text')).toHaveValue(JD_TEXT);
  });
});
