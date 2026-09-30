import { describe, expect, it } from 'vitest';
import { compareSubmissions, fingerprints, stripComments, tokens } from './code-similarity.js';

const original = `import sys
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

// The same program with every name changed, comments added and the layout altered.
const disguised = `import sys
from collections import defaultdict

# count the stretches
def solve():
    tokens = sys.stdin.read().split()   # read everything
    size, target = int(tokens[0]), int(tokens[1])
    prefix_counts = defaultdict(int)
    prefix_counts[0] = 1
    running = answer = 0
    for value in map(int, tokens[2:2 + size]):
        running += value
        answer += prefix_counts[running - target]
        prefix_counts[running] += 1
    print(answer)

solve()
`;

// An independent, brute-force solution to the same problem.
const independent = `import sys

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

const starter = `import sys


def main():
    data = sys.stdin.read()


if __name__ == "__main__":
    main()
`;

describe('code normalisation', () => {
  it('strips comments but not comment markers inside strings', () => {
    expect(stripComments('x = 1  # note\ny = "#not a comment"', 'python')).toBe(
      'x = 1  \ny = "#not a comment"',
    );
    expect(stripComments('a(); // c\n/* block */b();', 'javascript')).toBe('a(); \nb();');
    expect(stripComments('SELECT 1; -- why', 'sql')).toBe('SELECT 1; ');
  });

  it('turns names, numbers and strings into placeholders and keeps keywords', () => {
    expect(tokens('for (let total = 0; total < 10; total++) out("x")', 'javascript')).toEqual([
      'for',
      '(',
      'let',
      'V',
      '=',
      'N',
      'V',
      '<',
      'N',
      'V',
      '++',
      ')',
      'V',
      '(',
      'S',
      ')',
    ]);
  });
});

describe('submission similarity', () => {
  it('sees through renamed variables, comments and layout', () => {
    const score = compareSubmissions(original, disguised, 'python', starter)!;
    expect(score.similarity).toBeGreaterThanOrEqual(0.8);
    expect(score.containment).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps independent solutions to the same problem apart', () => {
    const score = compareSubmissions(original, independent, 'python', starter)!;
    expect(score.similarity).toBeLessThan(0.3);
  });

  it('is identical for identical code and ignores what came from the starter code', () => {
    expect(compareSubmissions(original, original, 'python', starter)).toMatchObject({
      similarity: 1,
      containment: 1,
    });
    // Starter code (plus a line) is too little of the candidate's own code to compare.
    expect(
      compareSubmissions(`${starter}\nprint(1)`, `${starter}\nprint(2)`, 'python', starter),
    ).toBeNull();
  });

  it('compares SQL case-insensitively and through renamed aliases', () => {
    const a = `SELECT p.category, COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
      FROM products AS p LEFT JOIN order_items AS oi ON oi.product_id = p.id
      GROUP BY p.category ORDER BY revenue DESC, p.category;`;
    const b = `-- revenue per category
      select x.category, coalesce(sum(y.quantity * y.unit_price), 0) as total
      from products as x left join order_items as y on y.product_id = x.id
      group by x.category order by total desc, x.category;`;
    expect(compareSubmissions(a, b, 'sql')!.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it('is deterministic', () => {
    expect([...fingerprints(original, 'python')]).toEqual([...fingerprints(original, 'python')]);
  });
});
