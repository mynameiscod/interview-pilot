/** TEST SUPPORT ONLY: library fixtures shared by the admin library tests. */
import type {
  BlueprintContent,
  BlueprintSummary,
  CompanySummary,
  ProblemSummary,
  RoleSummary,
  TemplateContent,
  TemplateSummary,
} from '@cbi/shared-types';

const now = new Date().toISOString();

export const blueprintContent = (): BlueprintContent => ({
  schemaVersion: 1,
  role: {
    title: 'Backend Engineer',
    family: 'ENGINEERING',
    seniority: 'MID',
    summary: 'Builds and runs services.',
  },
  competencies: [
    {
      key: 'api-design',
      name: 'API design',
      category: 'TECHNICAL',
      weight: 40,
      description: 'Designs clear APIs.',
      subCompetencies: ['REST'],
      expectedEvidence: ['Explains versioning trade-offs'],
      difficulty: 'MEDIUM',
      roundTypes: ['TECHNICAL'],
    },
    {
      key: 'debugging',
      name: 'Debugging',
      category: 'PROBLEM_SOLVING',
      weight: 30,
      description: 'Finds root causes.',
      subCompetencies: [],
      expectedEvidence: ['Walks through a real incident'],
      difficulty: 'MEDIUM',
      roundTypes: ['PROBLEM_SOLVING'],
    },
    {
      key: 'communication',
      name: 'Communication',
      category: 'COMMUNICATION',
      weight: 30,
      description: 'Explains clearly.',
      subCompetencies: [],
      expectedEvidence: ['Structured answers'],
      difficulty: 'EASY',
      roundTypes: ['INTRO', 'BEHAVIORAL'],
    },
  ],
  focusSkills: [{ name: 'Node.js', weight: 50, source: 'JD' }],
  probeAreas: [],
  notes: null,
});

export const role = (overrides: Partial<RoleSummary> = {}): RoleSummary => ({
  id: 'r1',
  title: 'Backend Engineer',
  slug: 'backend-engineer',
  family: 'ENGINEERING',
  defaultSeniority: 'MID',
  aliases: ['Server-side developer'],
  activeBlueprintId: 'b1',
  active: true,
  updatedAt: now,
  ...overrides,
});

export const blueprint = (overrides: Partial<BlueprintSummary> = {}): BlueprintSummary => ({
  id: 'b1',
  roleId: 'r1',
  origin: 'CANONICAL',
  version: 1,
  status: 'ACTIVE',
  content: blueprintContent(),
  contentHash: 'abcdef1234567890',
  generatedBy: null,
  sourceJobTargetId: null,
  createdAt: now,
  activatedAt: now,
  ...overrides,
});

export const company = (overrides: Partial<CompanySummary> = {}): CompanySummary => ({
  id: 'c1',
  name: 'Globex',
  slug: 'globex',
  description: null,
  website: 'https://globex.example',
  roleFamilies: ['ENGINEERING'],
  verifiedPatterns: [
    {
      note: 'Two technical rounds and a system design round.',
      sourceType: 'COMPANY_PUBLISHED',
      sourceUrl: null,
      verifiedBy: 'admin-9',
      verifiedAt: now,
    },
  ],
  allowedQuestionCategories: ['TECHNICAL', 'PROBLEM_SOLVING', 'COMMUNICATION'],
  active: true,
  updatedAt: now,
  ...overrides,
});

export const templateContent = (): TemplateContent => ({
  name: 'Standard technical interview',
  description: 'Intro, technical and wrap-up.',
  modes: ['TEXT'],
  rounds: [
    {
      type: 'INTRO',
      durationSec: 300,
      questionCount: 2,
      difficulty: 'EASY',
      followUpDepth: 1,
      minEvidence: 1,
    },
    {
      type: 'TECHNICAL',
      durationSec: 1200,
      questionCount: 4,
      difficulty: 'ADAPTIVE',
      followUpDepth: 2,
      minEvidence: 3,
    },
  ],
  codingRequired: false,
  creditCost: 1,
  proctoringPolicy: { recording: 'OFF', tabSwitchTracking: false },
  scoringPolicy: {
    dimensionWeights: {
      TECHNICAL: 35,
      PROBLEM_SOLVING: 25,
      COMMUNICATION: 15,
      BEHAVIORAL: 15,
      DOMAIN: 10,
    },
  },
  reportPolicy: { showDimensionScores: true, showTranscript: true },
});

export const template = (overrides: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: 't1',
  key: 'standard-technical',
  version: 1,
  status: 'ACTIVE',
  content: templateContent(),
  totalDurationSec: 1500,
  createdAt: now,
  activatedAt: now,
  ...overrides,
});

export const problem = (overrides: Partial<ProblemSummary> = {}): ProblemSummary => ({
  id: 'prob-two-sum-2',
  key: 'two-sum',
  version: 2,
  active: true,
  title: 'Two sum',
  statement:
    'Given `n` numbers and a target, print the indices of the two numbers that add up to the target.\n\nPrint them in increasing order.',
  difficulty: 'EASY',
  tags: ['arrays', 'hashing'],
  languages: ['python', 'javascript'],
  starterCode: {
    python: 'import sys\n\ndef solve():\n    pass\n',
    javascript: "const data = require('fs').readFileSync(0, 'utf8');\n",
  },
  visibleTests: [{ input: '4\n2 7 11 15\n9\n', expectedOutput: '0 1\n', explanation: '2 + 7 = 9' }],
  hiddenTests: [
    { input: '3\n3 2 4\n6\n', expectedOutput: '1 2\n', explanation: null },
    { input: '2\n3 3\n6\n', expectedOutput: '0 1\n', explanation: null },
  ],
  limits: { cpuMs: 2000, memoryMb: 256 },
  createdAt: now,
  ...overrides,
});
