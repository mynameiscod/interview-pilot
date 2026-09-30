import { createLogger } from '@cbi/config';
import {
  CodeSimilarityFlagModel,
  CodingAttemptModel,
  connectMongo,
  disconnectMongo,
  ensureIndexes,
  ensureProblemBank,
  InterviewSessionModel,
  mongoose,
  ProblemModel,
} from '@cbi/db';
import type { CodingLanguage } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processCodeSimilarity } from './code-similarity.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureProblemBank();
});
afterAll(disconnectMongo);

const solution = `import sys
from collections import defaultdict


def main():
    data = sys.stdin.read().split()
    n, k = int(data[0]), int(data[1])
    seen = defaultdict(int)
    seen[0] = 1
    total = count = 0
    for x in map(int, data[2:2 + n]):
        total += x
        count += seen[total - k]
        seen[total] += 1
    print(count)


main()
`;
const renamed = solution
  .replaceAll('seen', 'prefix')
  .replaceAll('total', 'running')
  .replaceAll('count', 'answer');
const different = `import sys

def main():
    nums = list(map(int, sys.stdin.read().split()))
    n, k = nums[0], nums[1]
    arr = nums[2:]
    result = 0
    for i in range(n):
        s = 0
        for j in range(i, n):
            s += arr[j]
            if s == k:
                result += 1
    print(result)

if __name__ == "__main__":
    main()
`;

/** A submitted attempt at `subarray-sum-count` in a (campaign) interview. */
async function submitted(
  campaignId: mongoose.Types.ObjectId | null,
  code: string,
  language: CodingLanguage = 'python',
) {
  const problem = await ProblemModel.findOne({ key: 'subarray-sum-count', active: true }).lean();
  const userId = oid();
  const s = await InterviewSessionModel.create({
    userId,
    jobTargetId: oid(),
    templateId: oid(),
    blueprintId: oid(),
    state: 'REPORT_READY',
    campaignId,
  });
  await CodingAttemptModel.create({
    sessionId: s._id,
    userId,
    questionId: `q-${String(s._id)}`,
    problemId: problem!._id,
    language,
    code,
    submission: {
      at: new Date(),
      language,
      code,
      result: null,
      judgeUnavailable: true,
      source: 'CANDIDATE',
    },
  });
  return String(s._id);
}

describe('code similarity in campaigns', () => {
  it('flags near-copies within a campaign once per pair, and nothing else', async () => {
    const campaign = oid();
    const a = await submitted(campaign, solution);
    const b = await submitted(campaign, renamed);
    await submitted(campaign, different);
    await submitted(campaign, renamed, 'javascript'); // another language is not compared
    await submitted(oid(), renamed); // another campaign
    await submitted(null, solution); // practice interview

    const first = await processCodeSimilarity({ sessionId: b, threshold: 0.8, logger });
    expect(first).toEqual({ compared: 2, flagged: 1 });
    const flags = await CodeSimilarityFlagModel.find().lean();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      problemKey: 'subarray-sum-count',
      language: 'python',
      threshold: 0.8,
    });
    expect(flags[0]!.similarity).toBeGreaterThanOrEqual(0.8);
    expect([String(flags[0]!.a.sessionId), String(flags[0]!.b.sessionId)].sort()).toEqual(
      [a, b].sort(),
    );

    // The other interview of the pair finds the same pair: still one record.
    await processCodeSimilarity({ sessionId: a, threshold: 0.8, logger });
    expect(await CodeSimilarityFlagModel.countDocuments()).toBe(1);
  });

  it('does nothing for practice interviews', async () => {
    const id = await submitted(null, solution);
    await submitted(null, solution);
    expect(await processCodeSimilarity({ sessionId: id, threshold: 0.8, logger })).toEqual({
      compared: 0,
      flagged: 0,
    });
  });
});
