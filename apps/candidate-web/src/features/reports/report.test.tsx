import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { makeReport } from '../../test/report-fixtures';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
/** The first render loads the lazy route, which can be slow on a busy machine. */
const LOAD = { timeout: 5_000 };

function reportApi(report = makeReport(), extra: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    ...signedIn,
    'GET /reports/int1': () => ok(report),
    'GET /feedback/int1': () => ok(null),
    ...extra,
  });
}

async function openReport(api = reportApi(), path = '/app/reports/int1') {
  const utils = await renderRoute(path, { api });
  await screen.findByRole('heading', { level: 1, name: 'Backend Developer' }, LOAD);
  return utils;
}

describe('readiness report', () => {
  it('shows the header, disclaimer, gauge with band text and the confidence chip', async () => {
    await openReport();

    expect(screen.getByText('Acme Labs')).toBeInTheDocument();
    expect(screen.getByText(/It is practice feedback, not a hiring decision/)).toBeInTheDocument();
    expect(screen.getByText('AI-generated.')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'Overall readiness 64 out of 100: Interview-ready with gaps',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Interview-ready with gaps')).toBeInTheDocument();
    expect(screen.getByText('Evidence confidence: Medium')).toBeInTheDocument();

    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'What affects confidence' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Separate questions answered')).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const factor = screen.getByText('Separate questions answered');
    expect(factor).toBeVisible();
    expect(factor.parentElement).toHaveTextContent('80%');
  });

  it('sorts skills by score with unscored ones last, and expands to show evidence', async () => {
    await openReport();
    const skills = screen.getByRole('region', { name: 'Skills' });
    const rows = within(skills).getAllByRole('button', { expanded: false });
    expect(rows.map((b) => b.textContent)).toEqual([
      'Communication80/100',
      'Node.js72/100',
      'SQL48/100',
      'TestingNot assessed',
    ]);
    expect(within(skills).getByText('Weight 40%')).toBeInTheDocument();

    const user = userEvent.setup();
    const claim = within(skills).getByText(
      'Described building a REST API with Express and pagination.',
    );
    expect(claim).not.toBeVisible();
    await user.click(within(skills).getByRole('button', { name: /Node\.js/ }));
    expect(within(skills).getByRole('button', { name: /Node\.js/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(claim).toBeVisible();
    expect(within(skills).getAllByText('Strong evidence')[0]).toBeVisible();
    expect(
      within(skills).getByText('From the question: Tell me about an API you built.'),
    ).toBeVisible();
    expect(
      within(skills).getByText(/I added cursor pagination because offsets were slow\./),
    ).toBeVisible();

    await user.click(within(skills).getByRole('button', { name: /SQL/ }));
    expect(within(skills).getByText('Weak')).toBeVisible();
    expect(within(skills).getByText(/scored from the strength of the evidence only/)).toBeVisible();
  });

  it('shows the same skill data as a table', async () => {
    await openReport();
    const user = userEvent.setup();
    const skills = screen.getByRole('region', { name: 'Skills' });
    const toggle = within(skills).getByRole('button', { name: 'Show as table' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const table = within(skills).getByRole('table', { name: 'Skill scores' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['20%', '80/100', '0'],
      ['40%', '72/100', '1'],
      ['25%', '48/100', '1'],
      ['15%', 'Not assessed', '0'],
    ]);
    expect(within(rows[3]!).getByRole('rowheader')).toHaveTextContent('Testing');
  });

  it('shows strengths, gaps, rounds and the coverage matrix in text', async () => {
    await openReport();
    const strengths = screen.getByRole('region', { name: 'Strengths' });
    expect(within(strengths).getByText(/solid hands-on experience/)).toBeInTheDocument();
    const gaps = screen.getByRole('region', { name: 'Gaps to work on' });
    expect(within(gaps).getByText(/Indexing and query plans/)).toBeInTheDocument();

    const rounds = screen.getByRole('region', { name: 'Rounds' });
    const technical = within(rounds).getByRole('row', { name: /Technical/ });
    expect(
      within(technical)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['5', '4', '20 minutes']);
    const coverage = screen.getByRole('region', { name: 'Resume and job description coverage' });
    const docker = within(coverage).getByRole('row', { name: /Docker/ });
    expect(
      within(docker)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Job description', 'No', 'No']);
  });

  it('switches plan tabs with the arrow keys, Home and End', async () => {
    await openReport();
    const user = userEvent.setup();
    const first = screen.getByRole('tab', { name: 'Next 24 hours' });
    const second = screen.getByRole('tab', { name: 'Next 3 days' });
    const third = screen.getByRole('tab', { name: 'Next 7 days' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Read how B-tree indexes work.');

    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-selected', 'false');
    expect(second).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Optimise three slow queries');

    await user.keyboard('{End}');
    expect(third).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Write integration tests');
    await user.keyboard('{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(third).toHaveFocus();
    await user.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('explains when there was not enough evidence for an overall score', async () => {
    const report = makeReport({
      content: {
        overall: {
          score: null,
          band: 'INSUFFICIENT_EVIDENCE',
          confidence: {
            level: 'LOW',
            value: 0.1,
            factors: {
              independentQuestions: 0.1,
              practicalEvidence: 0,
              consistency: 0.2,
              completeness: 0.1,
            },
          },
          assessedWeight: 0.1,
        },
      },
    });
    await openReport(reportApi(report));
    expect(
      screen.getByRole('img', {
        name: 'Overall readiness not scored: Not enough evidence yet',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Not enough evidence yet')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'We could not give an overall score' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not enough answers or enough evidence/)).toBeInTheDocument();
    expect(screen.getByText('Evidence confidence: Low')).toBeInTheDocument();
  });

  it('shows progress since the previous attempt with a compare link', async () => {
    const report = makeReport({
      content: {
        previous: {
          sessionId: 'int0',
          overall: 50,
          endedAt: '2026-09-10T10:25:00.000Z',
          deltas: [
            { key: 'nodejs', name: 'Node.js', delta: 12 },
            { key: 'sql', name: 'SQL', delta: -7 },
            { key: 'communication', name: 'Communication', delta: 0 },
          ],
        },
      },
    });
    await openReport(reportApi(report));
    const next = screen.getByRole('region', { name: 'What next' });
    expect(within(next).getByText('Previous overall: 50/100')).toBeInTheDocument();
    expect(within(next).getByText('Overall change: +14 (improved)')).toBeInTheDocument();
    expect(within(next).getByText('Node.js').parentElement).toHaveTextContent('+12 (improved)');
    expect(within(next).getByText('SQL').parentElement).toHaveTextContent('−7 (declined)');
    expect(within(next).getByText('Communication').parentElement).toHaveTextContent(
      '0 (no change)',
    );
    expect(within(next).getByRole('link', { name: 'Compare attempts' })).toHaveAttribute(
      'href',
      '/app/compare?sessions=int0,int1',
    );
    expect(within(next).getByRole('link', { name: 'Practise again' })).toHaveAttribute(
      'href',
      '/app/new',
    );
  });

  it('shows the transcript collapsed', async () => {
    await openReport();
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Transcript (1 question)' });
    expect(screen.getByText('Tell me about yourself.')).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByText('Tell me about yourself.')).toBeVisible();
  });

  it('explains when the report is not ready yet', async () => {
    const api = fakeApi({ ...signedIn, 'GET /reports/int1': () => fail(404, 'NOT_FOUND') });
    await renderRoute('/app/reports/int1', { api });
    expect(
      await screen.findByRole('heading', { name: 'Your report is not ready yet' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check progress' })).toHaveAttribute(
      'href',
      '/app/interviews/int1/complete',
    );
  });
});

describe('report PDF', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('shows a disabled button while the PDF is being prepared', async () => {
    await openReport(reportApi(makeReport({ pdfReady: false })));
    expect(screen.getByRole('button', { name: 'Preparing PDF…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
  });

  it('downloads the PDF with the access token', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['%PDF-1.7']), {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="readiness-report-int1.pdf"',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn(() => 'blob:report');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    let downloaded: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });

    await openReport();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/reports\/int1\/pdf$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
    expect(downloaded).toBe('readiness-report-int1.pdf');
  });

  it('says so when the PDF is still being prepared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INVALID_STATE', message: 'x' } }), {
            status: 409,
          }),
      ),
    );
    await openReport();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The PDF is still being prepared. Please try again in a minute.',
    );
  });
});

describe('report feedback', () => {
  it('posts the ratings and shows the thanks state', async () => {
    const api = reportApi(makeReport(), {
      'POST /feedback': (body) =>
        ok({ ...(body as object), createdAt: '2026-09-20T11:00:00.000Z' }),
    });
    await openReport(api);
    const user = userEvent.setup();
    const card = screen.getByRole('region', { name: 'Rate this report' });
    expect(card).toHaveAttribute('id', 'feedback');

    await user.click(await within(card).findByRole('button', { name: 'Send feedback' }));
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'Please choose a rating for all three questions.',
    );
    expect(api.calls.some((c) => c.key === 'POST /feedback')).toBe(false);

    const pick = async (group: string, option: string) =>
      user.click(
        within(within(card).getByRole('group', { name: group })).getByRole('radio', {
          name: option,
        }),
      );
    await pick('How useful was this report?', '4');
    await pick('How accurate did it feel?', '3');
    await pick('How good was the interview itself?', '5');
    await pick('Would you take another interview?', 'Yes');
    await user.type(
      within(card).getByRole('textbox', { name: /Anything else/ }),
      'More SQL questions please',
    );
    await user.click(within(card).getByRole('button', { name: 'Send feedback' }));

    expect(
      await within(card).findByText('Thanks — you can update your rating any time.'),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /feedback')?.body).toEqual({
      sessionId: 'int1',
      ratings: { usefulness: 4, accuracy: 3, interviewQuality: 5 },
      freeText: 'More SQL questions please',
      intendsRetake: true,
    });
    expect(within(card).getByRole('button', { name: 'Update feedback' })).toBeInTheDocument();
  });

  it('loads existing feedback and lands on it from the feedback link', async () => {
    const api = reportApi(makeReport(), {
      'GET /feedback/int1': () =>
        ok({
          sessionId: 'int1',
          ratings: { usefulness: 2, accuracy: 4, interviewQuality: 3 },
          freeText: null,
          intendsRetake: false,
          createdAt: '2026-09-20T11:00:00.000Z',
        }),
    });
    await openReport(api, `/app/reports/int1#${'feedback'}`);
    const card = screen.getByRole('region', { name: 'Rate this report' });
    expect(
      await within(card).findByText('Thanks — you can update your rating any time.'),
    ).toBeInTheDocument();
    const usefulness = within(card).getByRole('group', { name: 'How useful was this report?' });
    expect(within(usefulness).getByRole('radio', { name: '2' })).toBeChecked();
    const retake = within(card).getByRole('group', { name: 'Would you take another interview?' });
    expect(within(retake).getByRole('radio', { name: 'No' })).toBeChecked();
    await waitFor(() => expect(card).toHaveFocus());
  });
});
