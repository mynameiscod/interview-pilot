import { ProblemContent } from '@cbi/shared-types';
import { ProblemModel } from '../models/coding.js';

const starter = {
  python:
    'import sys\n\n\ndef main():\n    data = sys.stdin.read()\n    # Write your solution here\n\n\nif __name__ == "__main__":\n    main()\n',
  javascript:
    "const input = require('fs').readFileSync(0, 'utf8');\n\n// Write your solution here\n",
  java: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // Write your solution here\n    }\n}\n',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // Write your solution here\n    return 0;\n}\n',
};

const languages = ['python', 'javascript', 'java', 'cpp'] as const;
const limits = { cpuMs: 2000, memoryMb: 256 };

/** Version 1 of the seeded coding problems (stdin → stdout). Admins add more in the console. */
export const SEED_PROBLEMS: { key: string; content: ProblemContent }[] = [
  {
    key: 'pair-sum-indices',
    content: {
      title: 'Pair sum indices',
      statement: [
        'You are given a list of integers and a target. Exactly one pair of different positions adds up to the target. Print the two positions (0-based), smaller first.',
        'Input: the first line has `n` and `target`. The second line has `n` integers.',
        'Output: two indices `i j` with `i < j`.',
        'Aim for better than checking every pair.',
      ].join('\n\n'),
      difficulty: 'EASY',
      tags: ['arrays', 'hashing'],
      languages: [...languages],
      starterCode: starter,
      visibleTests: [
        { input: '4 9\n2 7 11 15\n', expectedOutput: '0 1\n', explanation: '2 + 7 = 9' },
        { input: '3 6\n3 2 4\n', expectedOutput: '1 2\n', explanation: null },
      ],
      hiddenTests: [
        { input: '2 6\n3 3\n', expectedOutput: '0 1\n', explanation: null },
        { input: '5 10\n1 2 3 4 6\n', expectedOutput: '3 4\n', explanation: null },
        { input: '6 0\n-3 4 2 -2 5 1\n', expectedOutput: '2 3\n', explanation: null },
        { input: '4 100\n50 1 2 50\n', expectedOutput: '0 3\n', explanation: null },
      ],
      limits,
    },
  },
  {
    key: 'balanced-brackets',
    content: {
      title: 'Balanced brackets',
      statement: [
        'Given a string made of the characters `()[]{}`, decide whether every bracket is closed by the matching bracket in the right order.',
        'Input: one line with the string (1 to 100 000 characters).',
        'Output: `YES` if it is balanced, otherwise `NO`.',
      ].join('\n\n'),
      difficulty: 'EASY',
      tags: ['stacks', 'strings'],
      languages: [...languages],
      starterCode: starter,
      visibleTests: [
        { input: '([]{})\n', expectedOutput: 'YES\n', explanation: null },
        { input: '([)]\n', expectedOutput: 'NO\n', explanation: 'The ] closes a ( .' },
      ],
      hiddenTests: [
        { input: '()\n', expectedOutput: 'YES\n', explanation: null },
        { input: '(((\n', expectedOutput: 'NO\n', explanation: null },
        { input: '{[()()]}\n', expectedOutput: 'YES\n', explanation: null },
        { input: '}\n', expectedOutput: 'NO\n', explanation: null },
        { input: '[{]}\n', expectedOutput: 'NO\n', explanation: null },
      ],
      limits,
    },
  },
  {
    key: 'merge-intervals',
    content: {
      title: 'Merge intervals',
      statement: [
        'Given closed intervals `[a, b]`, merge every group of overlapping or touching intervals and print the result in increasing order.',
        'Input: the first line has `n`. Each of the next `n` lines has `a b` with `a <= b`.',
        'Output: one merged interval `a b` per line, sorted by start.',
      ].join('\n\n'),
      difficulty: 'MEDIUM',
      tags: ['sorting', 'intervals'],
      languages: [...languages],
      starterCode: starter,
      visibleTests: [
        {
          input: '4\n1 3\n2 6\n8 10\n15 18\n',
          expectedOutput: '1 6\n8 10\n15 18\n',
          explanation: '[1,3] and [2,6] overlap.',
        },
        {
          input: '2\n1 4\n4 5\n',
          expectedOutput: '1 5\n',
          explanation: 'Touching intervals merge.',
        },
      ],
      hiddenTests: [
        { input: '1\n5 7\n', expectedOutput: '5 7\n', explanation: null },
        { input: '3\n6 8\n1 9\n2 4\n', expectedOutput: '1 9\n', explanation: null },
        {
          input: '4\n1 2\n3 4\n5 6\n7 8\n',
          expectedOutput: '1 2\n3 4\n5 6\n7 8\n',
          explanation: null,
        },
        { input: '3\n1 10\n2 3\n11 12\n', expectedOutput: '1 10\n11 12\n', explanation: null },
      ],
      limits,
    },
  },
  {
    key: 'top-k-words',
    content: {
      title: 'Most frequent words',
      statement: [
        'Given a line of lower-case words separated by spaces, print the `k` most frequent words with their counts.',
        'Order by count (highest first), and alphabetically when counts are equal.',
        'Input: the first line has `k`. The second line has the words.',
        'Output: `k` lines of `word count`.',
      ].join('\n\n'),
      difficulty: 'MEDIUM',
      tags: ['hashing', 'sorting', 'strings'],
      languages: [...languages],
      starterCode: starter,
      visibleTests: [
        {
          input: '2\nthe cat and the hat and the bat\n',
          expectedOutput: 'the 3\nand 2\n',
          explanation: null,
        },
      ],
      hiddenTests: [
        { input: '1\na b c\n', expectedOutput: 'a 1\n', explanation: null },
        { input: '3\nx y x z y x\n', expectedOutput: 'x 3\ny 2\nz 1\n', explanation: null },
        { input: '2\nb a b a c\n', expectedOutput: 'a 2\nb 2\n', explanation: null },
      ],
      limits,
    },
  },
];

/** Inserts version 1 (active) of each seed problem whose key has no versions yet. */
export async function ensureProblemBank(): Promise<number> {
  let created = 0;
  for (const seed of SEED_PROBLEMS) {
    if (await ProblemModel.exists({ key: seed.key })) continue;
    try {
      await ProblemModel.create({
        key: seed.key,
        version: 1,
        active: true,
        content: ProblemContent.parse(seed.content),
        reason: 'Seeded default',
      });
      created++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return created;
}
