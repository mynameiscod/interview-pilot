import {
  CreateProblemVersionBody,
  PROGRAM_LANGUAGES,
  type CodingLanguage,
  type ProblemContent,
} from '@cbi/shared-types';
import type { Model } from 'mongoose';
import { ProblemModel } from '../models/coding.js';
import { PROBLEM_BANK, type SeedProblem } from './problem-bank/index.js';
import { ensureVersionedSeed, type VersionedDoc } from './versioned.js';

const DEFAULT_LIMITS = { cpuMs: 2000, memoryMb: 256 };

/**
 * Starter code: reads standard input and leaves the solution to the
 * candidate. Every template compiles as is on Judge0 (TypeScript declares
 * `require`, Go uses what it imports).
 */
export function starterCode(title: string): Partial<Record<CodingLanguage, string>> {
  const task = `${title}: read the input from standard input and print the answer.`;
  return {
    python: `import sys\n\n\ndef main():\n    # ${task}\n    data = sys.stdin.read()\n\n\nif __name__ == "__main__":\n    main()\n`,
    javascript: `// ${task}\nconst input = require('fs').readFileSync(0, 'utf8');\n\n// Write your solution here\n`,
    java: `import java.util.*;\nimport java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        // ${task}\n        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));\n    }\n}\n`,
    cpp: `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // ${task}\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    return 0;\n}\n`,
    typescript: `// ${task}\ndeclare const require: (module: string) => any;\nconst input: string = require('fs').readFileSync(0, 'utf8');\n\n// Write your solution here\n`,
    go: `package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\t// ${task}\n\tin := bufio.NewReader(os.Stdin)\n\tout := bufio.NewWriter(os.Stdout)\n\tdefer out.Flush()\n\t_, _ = in, fmt.Fprintln // e.g. fmt.Fscan(in, &n) and fmt.Fprintln(out, answer)\n}\n`,
    csharp: `using System;\nusing System.Collections.Generic;\nusing System.Linq;\n\npublic class Program\n{\n    public static void Main()\n    {\n        // ${task}\n        string input = Console.In.ReadToEnd();\n    }\n}\n`,
    c: `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\nint main(void) {\n    /* ${task} */\n    return 0;\n}\n`,
    kotlin: `import java.io.*\n\nfun main() {\n    // ${task}\n    val input = BufferedReader(InputStreamReader(System.\`in\`)).readText()\n}\n`,
    rust: `use std::io::{self, Read};\n\nfn main() {\n    // ${task}\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n}\n`,
  };
}

const SQL_STARTER =
  '-- Write one SQLite query. The tables are created and filled before it runs.\nSELECT 1;\n';

/** The problem version content for a seed problem. */
export function seedContent(p: SeedProblem): ProblemContent {
  const sql = p.sql ?? null;
  return {
    title: p.title,
    statement: p.statement.join('\n\n'),
    difficulty: p.difficulty,
    tags: p.tags,
    companyTags: p.companyTags,
    languages: sql ? ['sql'] : [...PROGRAM_LANGUAGES],
    starterCode: sql ? { sql: SQL_STARTER } : starterCode(p.title),
    visibleTests: p.visibleTests,
    hiddenTests: p.hiddenTests.map(([input, expectedOutput]) => ({
      input,
      expectedOutput,
      explanation: null,
    })),
    limits: p.limits ?? DEFAULT_LIMITS,
    sql,
  };
}

/** The seeded problems (validated like an admin's new version). */
export const SEED_PROBLEMS: { key: string; revision: number; content: ProblemContent }[] =
  PROBLEM_BANK.map((p) => ({
    key: p.key,
    revision: p.revision,
    content: CreateProblemVersionBody.parse({
      key: p.key,
      content: seedContent(p),
      reason: 'Seeded problem',
    }).content,
  }));

/**
 * Idempotent, versioned seed of the problem bank (see ensureVersionedSeed:
 * an admin's version of a key is never replaced). Returns the versions created.
 */
export function ensureProblemBank(): Promise<number> {
  return ensureVersionedSeed(ProblemModel as unknown as Model<VersionedDoc>, SEED_PROBLEMS);
}
