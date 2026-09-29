import { EVAL_BLUEPRINT, type EvalFixture } from './fixtures.js';

/**
 * Human-labelled calibration answers. Regression fixtures check behaviour
 * (injection, bias, vague answers); calibration checks that scores agree
 * with how people grade the same answer. Each example is one question and
 * answer for one blueprint competency, with the score a rater gave it and
 * the range a second rater would still accept.
 *
 * To add examples: have at least two raters score the answer against the
 * competency's expected evidence (0-100, same bands as the scoring prompt),
 * record the agreed score and the range spanning both raters (at least ±8),
 * and name the raters or panel in `rater`. The seed examples below were
 * labelled by the engineering team and are marked as such; replace them with
 * panel-labelled answers as they become available.
 */
export interface CalibrationExample {
  id: string;
  /** A key of EVAL_BLUEPRINT.competencies. */
  competencyKey: string;
  question: string;
  answer: string;
  label: {
    /** The agreed human score, 0-100. */
    score: number;
    /** Inclusive range of acceptable scores. */
    range: [number, number];
    /** Who labelled it (panel, raters, or `seed`). */
    rater: string;
    /** Why the answer earns this score, in the rubric's terms. */
    rationale: string;
  };
}

export const CALIBRATION_EXAMPLES: CalibrationExample[] = [
  {
    id: 'cal-api-strong',
    competencyKey: 'api-design',
    question:
      'How would you design an API that lets clients create payments safely, even if they retry?',
    answer:
      'POST /payments with a required Idempotency-Key header. I store the key plus a hash of the body under a unique index inside the same transaction as the payment row, so a retry returns the stored 201 and a reused key with a different body gets 422. Amounts are integers in paise, errors use one problem+json format, and the version is in the path. Clients authenticate with OAuth client credentials.',
    label: {
      score: 85,
      range: [75, 95],
      rater: 'seed (engineering team)',
      rationale: 'Covers idempotency, error shape, money representation, versioning and auth.',
    },
  },
  {
    id: 'cal-api-partial',
    competencyKey: 'api-design',
    question:
      'How would you design an API that lets clients create payments safely, even if they retry?',
    answer:
      'I would add a POST endpoint for payments and check in the database whether the same payment already exists before inserting, so retries do not create duplicates. I would return clear error messages.',
    label: {
      score: 55,
      range: [45, 65],
      rater: 'seed (engineering team)',
      rationale:
        'Sees the duplicate problem but the check-then-insert approach races; nothing on keys, errors or auth.',
    },
  },
  {
    id: 'cal-api-weak',
    competencyKey: 'api-design',
    question:
      'How would you design an API that lets clients create payments safely, even if they retry?',
    answer: 'I would follow REST best practices and make sure the API is secure and scalable.',
    label: {
      score: 20,
      range: [5, 35],
      rater: 'seed (engineering team)',
      rationale: 'Generic; no design decisions.',
    },
  },
  {
    id: 'cal-debug-strong',
    competencyKey: 'debugging',
    question: 'Tell me about a production incident you debugged. How did you find the cause?',
    answer:
      'Order confirmations stopped for about 5% of users. Error rates were flat, so I compared successful and failed orders in the logs and saw every failure had a phone number with a leading plus. A validation library upgrade had changed the default. I reproduced it with a unit test, pinned the old behaviour behind a flag, replayed the stuck confirmations and added a contract test for phone formats.',
    label: {
      score: 82,
      range: [72, 92],
      rater: 'seed (engineering team)',
      rationale: 'Systematic narrowing, uses logs, verifies with a test and prevents recurrence.',
    },
  },
  {
    id: 'cal-debug-partial',
    competencyKey: 'debugging',
    question: 'Tell me about a production incident you debugged. How did you find the cause?',
    answer:
      'Our service was slow once. I looked at the logs and saw some database queries were slow, so I added an index and it got faster.',
    label: {
      score: 50,
      range: [40, 62],
      rater: 'seed (engineering team)',
      rationale:
        'Some evidence of using logs and a fix, but no hypothesis, verification or prevention.',
    },
  },
  {
    id: 'cal-collab-strong',
    competencyKey: 'collaboration',
    question: 'Describe a time you disagreed with a teammate about a technical decision.',
    answer:
      'A colleague wanted to rewrite our reporting service in Go. I felt the problem was two slow queries, not the language. I suggested we timebox a profiling day together first; the profile showed 80% of the time in those queries. We fixed them, cut report time from 40 s to 3 s, and agreed to revisit the rewrite only if we missed the target again. We have not needed to.',
    label: {
      score: 84,
      range: [74, 94],
      rater: 'seed (engineering team)',
      rationale: 'Constructive handling, evidence-based trade-off, concrete outcome.',
    },
  },
];

/** Each calibration example as a one-question fixture whose final score must fall in its labelled range. */
export function calibrationFixtures(
  examples: readonly CalibrationExample[] = CALIBRATION_EXAMPLES,
): EvalFixture[] {
  return examples.map((e) => {
    const competency = EVAL_BLUEPRINT.competencies.find((c) => c.key === e.competencyKey);
    if (!competency) throw new Error(`${e.id}: unknown competency ${e.competencyKey}`);
    return {
      id: e.id,
      description: `Calibration (${e.label.rater}): ${e.label.rationale}`,
      turns: [
        {
          questionId: `${e.id}-q`,
          roundType: competency.roundTypes[0]!,
          competencyKey: e.competencyKey,
          question: e.question,
          answer: e.answer,
        },
      ],
      expectations: [
        {
          kind: 'dimensionScore',
          key: e.competencyKey,
          min: e.label.range[0],
          max: e.label.range[1],
          // A clearly weak answer may yield no evidence at all.
          unscoredOk: e.label.range[0] <= 20,
        },
      ],
      label: { competencyKey: e.competencyKey, score: e.label.score, range: e.label.range },
    };
  });
}
