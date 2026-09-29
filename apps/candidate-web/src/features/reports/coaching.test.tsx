import type { QuestionFeedback, ReportContent } from '@cbi/shared-types';
import { fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../test/render';
import { makeReport } from '../../test/report-fixtures';

const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
/** The first render loads the lazy route, which can be slow on a busy machine. */
const LOAD = { timeout: 15_000 };

const question = (over: Partial<QuestionFeedback> = {}): QuestionFeedback => ({
  questionId: 'q1',
  seq: 1,
  roundType: 'BEHAVIORAL',
  question: 'Tell me about a time you fixed an outage.',
  answer: 'I added tracing and found a slow query, so I built an index.',
  spoken: true,
  behavioural: true,
  verdict: 'ADEQUATE',
  whatWorked: ['You named the root cause.'],
  missing: ['Say what the result was.'],
  improvedAnswer:
    'During a sale our checkout timed out. I added tracing... cut latency by [your metric].',
  star: { situation: false, task: false, action: true, result: false, source: 'AI' },
  fallback: false,
  ...over,
});

const coaching: Partial<ReportContent> = {
  questions: [
    question(),
    question({
      questionId: 'q2',
      seq: 2,
      roundType: 'TECHNICAL',
      behavioural: false,
      spoken: false,
      verdict: 'UNASSESSED',
      whatWorked: [],
      missing: ['Explains idempotency keys'],
      improvedAnswer: null,
      star: null,
      fallback: true,
    }),
  ],
  structure: {
    behaviouralAnswers: 1,
    complete: 0,
    counts: { situation: 0, task: 0, action: 1, result: 0 },
    weakest: 'result',
  },
  delivery: {
    summary: {
      answers: 1,
      durationSec: 60,
      wordCount: 180,
      wpm: 180,
      fillerCount: 9,
      fillerRate: 5,
      topFillers: [{ text: 'um', count: 6 }],
      longPauses: null,
      hedgeCount: 1,
      topHedges: [],
    },
    tips: ['PACE_FAST', 'FILLERS'],
    answers: [
      {
        questionId: 'q1',
        seq: 1,
        metrics: {
          durationSec: 60.2,
          wordCount: 180,
          wpm: 180,
          fillerCount: 9,
          fillerRate: 5,
          topFillers: [],
          longPauses: null,
          longestPauseSec: null,
          hedgeCount: 1,
          topHedges: [],
          timestamps: false,
        },
      },
    ],
  },
  benchmark: {
    percentile: 64,
    sampleSize: 41,
    basis: 'ROLE',
    roleTitle: 'Backend Developer',
    family: null,
    windowDays: 180,
  },
};

async function open(content: Partial<ReportContent> = coaching) {
  const api = fakeApi({
    ...signedIn,
    'GET /reports/int1': () => ok(makeReport({ content })),
    'GET /feedback/int1': () => ok(null),
  });
  await renderRoute('/app/reports/int1', { api });
  await screen.findByRole('heading', { level: 1, name: 'Backend Developer' }, LOAD);
}

const sections = () =>
  within(screen.getByRole('tablist', { name: 'Report sections' }))
    .getAllByRole('tab')
    .map((t) => t.textContent);

describe('report sections', () => {
  it('shows Summary, Questions, Delivery and Plan tabs, moved with the arrow keys', async () => {
    await open();
    expect(sections()).toEqual(['Summary', 'Questions', 'Delivery', 'Plan']);
    const summary = screen.getByRole('tab', { name: 'Summary' });
    expect(summary).toHaveAttribute('aria-selected', 'true');
    // The benchmark sits in the summary.
    expect(
      screen.getByText('Better than 64% of candidates practising for Backend Developer'),
    ).toBeInTheDocument();
    expect(screen.getByText(/41 other candidates in the last 180 days/)).toBeInTheDocument();

    const user = userEvent.setup();
    summary.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Questions' })).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Question by question' })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
  });

  it('hides Questions, Delivery and the benchmark for older or typed reports', async () => {
    await open({});
    expect(sections()).toEqual(['Summary', 'Plan']);
    expect(screen.queryByText(/Better than/)).toBeNull();
  });
});

describe('question cards', () => {
  it('shows the verdict, the collapsed answer, STAR, feedback and a labelled example', async () => {
    await open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Questions' }));

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    const first = within(cards[0]!);
    expect(first.getByRole('heading', { name: question().question })).toBeInTheDocument();
    expect(first.getByText('Verdict: Adequate')).toBeInTheDocument();
    expect(first.getByText(/Spoken answer/)).toBeInTheDocument();

    const toggle = first.getByRole('button', { name: 'Show your answer' });
    const answer = first.getByText(question().answer!);
    expect(answer).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(answer).toBeVisible();

    const star = first.getByRole('list', { name: 'Answer structure (STAR)' });
    expect(within(star).getByText('Action: covered')).toBeInTheDocument();
    expect(within(star).getByText('Result: missing')).toBeInTheDocument();
    expect(first.getByText('You named the root cause.')).toBeInTheDocument();
    expect(first.getByText('Say what the result was.')).toBeInTheDocument();
    expect(first.getByRole('heading', { name: 'Example answer' })).toBeInTheDocument();
    expect(first.getByText(/built from your own answer, not a script/)).toBeInTheDocument();
    expect(first.getByText(/\[your metric\]/)).toBeInTheDocument();

    // A fallback card: no STAR for a technical question, no invented example.
    const second = within(cards[1]!);
    expect(second.getByText('Verdict: Not assessed')).toBeInTheDocument();
    expect(second.queryByRole('list', { name: 'Answer structure (STAR)' })).toBeNull();
    expect(
      second.getByText(/based on the assessment made during the interview/),
    ).toBeInTheDocument();
    expect(
      second.getByRole('heading', { name: 'What a strong answer usually covers' }),
    ).toBeInTheDocument();
    expect(second.getByText(/not enough in this answer to build an example/)).toBeInTheDocument();
  });

  it('summarises STAR structure across behavioural answers', async () => {
    await open();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Questions' }));
    const structure = screen.getByRole('region', { name: 'Structure of your behavioural answers' });
    expect(structure).toHaveTextContent('0 of 1 behavioural answers covered');
    expect(structure).toHaveTextContent('Most often missing: Result.');
    expect(structure).toHaveTextContent(/End with the outcome/);
  });

  it('says when the answer is not shown in the report', async () => {
    await open({ questions: [question({ answer: null })] });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Questions' }));
    expect(screen.getByText('Your answer is not shown in this report.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show your answer' })).toBeNull();
  });
});

describe('delivery', () => {
  it('shows pace, fillers, pauses and hedging against targets, with tips and the fairness note', async () => {
    await open();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Delivery' }));
    const delivery = screen.getByRole('region', { name: 'Delivery' });
    expect(delivery).toHaveTextContent(/never affects your scores/);
    expect(delivery).toHaveTextContent('180 words per minute');
    expect(delivery).toHaveTextContent('Target: 120–160 words per minute');
    expect(delivery).toHaveTextContent('9 (5 per 100 words)');
    expect(delivery).toHaveTextContent('Most common: “um” × 6');
    expect(delivery).toHaveTextContent('Not measured');
    expect(delivery).toHaveTextContent(/Slow down a little/);
    expect(delivery).toHaveTextContent(/Replace filler words/);
    const table = within(delivery).getByRole('table', { name: 'Delivery for each spoken answer' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['60 s', '180', '9', '–']);
  });
});
