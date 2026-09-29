import type { PromptTemplateData } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import { SEED_PROMPTS } from '@cbi/db';
import type { QuestionFeedbackAi, StarCoverage } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { detectStar } from '../evaluation/star.js';
import {
  checkCoaching,
  COACHING_FIXTURES,
  runCoachingFixture,
  type CoachingFixture,
  type CoachingRun,
} from './coaching.js';
import { runEvalSuite } from './runner.js';

const logger = createLogger({ service: 'test', level: 'silent' });

/** A runtime whose coach returns `reply(fixtureAnswer)`, or fails when it returns null. */
function coach(reply: (userMessage: string) => QuestionFeedbackAi | null): AiRuntime {
  const seed = SEED_PROMPTS.find((p) => p.key === 'report.questionFeedback')!;
  const prompt: PromptTemplateData = { id: 'p', version: 1, locale: 'en', ...seed };
  return {
    prompts: { getActive: async () => prompt },
    router: {
      run: async (_f: string, req: { messages: { role: string; content: string }[] }) => {
        const data = reply(req.messages.find((m) => m.role === 'user')!.content);
        if (!data) throw new Error('unavailable');
        return { data, model: { modelId: 'test' } };
      },
    },
  } as unknown as AiRuntime;
}

const fixture = (id: string) => COACHING_FIXTURES.find((f) => f.id === id)!;

describe('coaching fixtures', () => {
  it('are well formed and cover invented facts, thin answers, injection and STAR', () => {
    const ids = COACHING_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of COACHING_FIXTURES) {
      for (const e of f.expectations) {
        if (e.kind === 'improvedExcludes') expect(() => new RegExp(e.pattern, 'i')).not.toThrow();
        if (e.kind === 'star') expect(f.behavioural, f.id).toBe(true);
      }
    }
    const kinds = new Set(COACHING_FIXTURES.flatMap((f) => f.expectations.map((e) => e.kind)));
    expect([...kinds].sort()).toEqual([
      'improvedExcludes',
      'improvedGrounded',
      'improvedPresent',
      'star',
      'verdict',
    ]);
    expect(COACHING_FIXTURES.some((f) => f.language !== 'en')).toBe(true);
  });

  it('agree with the deterministic STAR heuristic where marked', () => {
    for (const f of COACHING_FIXTURES.filter((x) => x.heuristicAgrees)) {
      const labels = f.expectations.find((e) => e.kind === 'star') as {
        expected: Partial<StarCoverage>;
      };
      expect(detectStar(f.answer), f.id).toMatchObject(labels.expected);
    }
  });
});

describe('checkCoaching', () => {
  const f: CoachingFixture = fixture('improved-no-invented-employer');
  const run = (over: Partial<CoachingRun> = {}): CoachingRun => ({
    verdict: 'ADEQUATE',
    improvedAnswer: 'I spoke to my teammate privately and we agreed on a review rotation.',
    star: { situation: true, task: false, action: true, result: true },
    grounding: { replacedNumbers: 0, ungroundedNames: 0 },
    unavailable: false,
    ...over,
  });

  it('passes a grounded example with the labelled STAR', () => {
    expect(checkCoaching(f, run(), 'full').every((c) => c.passed)).toBe(true);
  });

  it('fails invented names or numbers, excluded mentions, a missing example and wrong STAR', () => {
    const failed = checkCoaching(
      f,
      run({
        improvedAnswer: null,
        grounding: { replacedNumbers: 1, ungroundedNames: 1 },
        star: { situation: true, task: false, action: true, result: false },
      }),
      'full',
    ).filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toEqual([
      'example answer adds no numbers or names',
      'example answer given',
      'STAR situation=true action=true result=true',
    ]);
    const mentions = checkCoaching(
      f,
      run({ improvedAnswer: 'I moved us to Kubernetes.' }),
      'full',
    ).find((c) => c.name.startsWith('example answer never mentions'))!;
    expect(mentions).toMatchObject({ passed: false, detail: 'found: Kubernetes' });
  });

  it('only checks validity in structure mode', () => {
    expect(checkCoaching(f, run({ star: null }), 'structure')).toEqual([
      expect.objectContaining({ name: 'models answered', passed: true }),
    ]);
    expect(
      checkCoaching(
        f,
        { ...run(), unavailable: true, grounding: null, improvedAnswer: null },
        'full',
      ),
    ).toEqual([expect.objectContaining({ passed: false })]);
  });
});

describe('runCoachingFixture', () => {
  it('reports what the grounding check found in the raw example answer', async () => {
    const ai = coach(() => ({
      verdict: 'STRONG',
      whatWorked: ['Clear numbers.'],
      missing: [],
      improvedAnswer: 'At Flipkart I cut builds from 20 to 5 minutes, like Google does.',
      star: { situation: true, task: true, action: true, result: true },
    }));
    const out = await runCoachingFixture({ ai, logger }, fixture('improved-keeps-stated-metrics'));
    expect(out).toMatchObject({
      verdict: 'STRONG',
      improvedAnswer: null, // withheld: "Google" was never mentioned
      grounding: { replacedNumbers: 1, ungroundedNames: 1 },
      unavailable: false,
    });
  });

  it('runs inside the eval suite and fails when the coach is unavailable', async () => {
    const report = await runEvalSuite({ ai: coach(() => null), logger }, [], {
      mode: 'full',
      coaching: [fixture('star-missing-result')],
    });
    expect(report.passed).toBe(false);
    expect(report.fixtures[0]).toMatchObject({ id: 'star-missing-result', runs: [] });
  });
});
