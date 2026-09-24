import type { BlueprintContent, RoleFamily, Seniority, TemplateContent } from '@cbi/shared-types';

/**
 * Seeded interview library. Admins edit everything after first boot; the
 * seed only fills gaps and never overwrites. Blueprint content is validated
 * against BlueprintContent when seeded.
 */

export interface SeedRole {
  slug: string;
  title: string;
  family: RoleFamily;
  defaultSeniority: Seniority;
  aliases: string[];
  blueprint: BlueprintContent;
}

type Competency = BlueprintContent['competencies'][number];
const c = (x: Competency): Competency => x;

const ownership = (weight: number) =>
  c({
    key: 'ownership',
    name: 'Ownership and learning',
    category: 'BEHAVIORAL',
    weight,
    description: 'Takes responsibility for outcomes, handles setbacks and keeps improving.',
    subCompetencies: ['Accountability', 'Handling ambiguity', 'Learning from mistakes'],
    expectedEvidence: [
      'A specific situation where they owned a problem end to end',
      'What they changed afterwards, in their own words',
    ],
    difficulty: 'MEDIUM',
    roundTypes: ['BEHAVIORAL'],
  });

export const SEED_ROLES: SeedRole[] = [
  {
    slug: 'backend-engineer',
    title: 'Backend Engineer',
    family: 'ENGINEERING',
    defaultSeniority: 'MID',
    aliases: [
      'Backend Developer',
      'Server-side Engineer',
      'API Developer',
      'Node.js Developer',
      'Java Backend Developer',
    ],
    blueprint: {
      schemaVersion: 1,
      role: {
        title: 'Backend Engineer',
        family: 'ENGINEERING',
        seniority: 'MID',
        summary:
          'Builds and operates APIs and services: data modelling, reliability, performance and clear collaboration.',
      },
      competencies: [
        c({
          key: 'api-design',
          name: 'API design',
          category: 'TECHNICAL',
          weight: 20,
          description: 'Designs clear, versioned, secure APIs with sensible errors and pagination.',
          subCompetencies: [
            'Resource modelling',
            'Error handling',
            'Authentication',
            'Idempotency',
          ],
          expectedEvidence: [
            'Explains request/response design choices and trade-offs',
            'Handles retries and duplicate requests safely',
            'Mentions validation and authorisation at the boundary',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'data-modelling',
          name: 'Data modelling and storage',
          category: 'TECHNICAL',
          weight: 15,
          description: 'Chooses storage, schemas, indexes and transactions to fit access patterns.',
          subCompetencies: ['Schema design', 'Indexing', 'Transactions', 'Migrations'],
          expectedEvidence: [
            'Justifies a schema from the queries it must serve',
            'Knows when an index helps and what it costs',
            'Describes consistency needs and how they are met',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'system-design',
          name: 'System design',
          category: 'PROBLEM_SOLVING',
          weight: 20,
          description:
            'Breaks a product need into services, data flows and failure handling at realistic scale.',
          subCompetencies: ['Requirements', 'Scalability', 'Caching', 'Queues and async work'],
          expectedEvidence: [
            'Clarifies requirements and constraints before designing',
            'Identifies bottlenecks and failure modes',
            'Makes explicit trade-offs rather than listing technologies',
          ],
          difficulty: 'HARD',
          roundTypes: ['PROBLEM_SOLVING'],
        }),
        c({
          key: 'reliability-debugging',
          name: 'Reliability and debugging',
          category: 'PROBLEM_SOLVING',
          weight: 15,
          description:
            'Diagnoses production issues methodically and builds observable, resilient services.',
          subCompetencies: ['Logging and metrics', 'Incident response', 'Timeouts and retries'],
          expectedEvidence: [
            'Walks through a real incident: signal, hypothesis, fix, prevention',
            'Uses data (logs, metrics, traces) rather than guesswork',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL', 'PROBLEM_SOLVING'],
        }),
        c({
          key: 'code-quality',
          name: 'Code quality and testing',
          category: 'TECHNICAL',
          weight: 10,
          description: 'Writes maintainable code with the right level of automated tests.',
          subCompetencies: ['Unit and integration tests', 'Code review', 'Refactoring'],
          expectedEvidence: [
            'Explains what they test and why',
            'Gives an example of improving code safely',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'collaboration',
          name: 'Communication and collaboration',
          category: 'COMMUNICATION',
          weight: 10,
          description: 'Explains technical decisions clearly to engineers and non-engineers.',
          subCompetencies: ['Clarity', 'Working with product', 'Disagreeing constructively'],
          expectedEvidence: [
            'Structured, concise explanations',
            'An example of aligning others on a decision',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['INTRO', 'BEHAVIORAL'],
        }),
        ownership(10),
      ],
      focusSkills: [],
      probeAreas: [],
      notes: null,
    },
  },
  {
    slug: 'frontend-engineer',
    title: 'Frontend Engineer',
    family: 'ENGINEERING',
    defaultSeniority: 'MID',
    aliases: ['Frontend Developer', 'UI Engineer', 'React Developer', 'Web Developer'],
    blueprint: {
      schemaVersion: 1,
      role: {
        title: 'Frontend Engineer',
        family: 'ENGINEERING',
        seniority: 'MID',
        summary:
          'Builds fast, accessible, maintainable web interfaces and works closely with design and product.',
      },
      competencies: [
        c({
          key: 'javascript-fundamentals',
          name: 'JavaScript and TypeScript fundamentals',
          category: 'TECHNICAL',
          weight: 20,
          description: 'Understands the language, the event loop, async code and types.',
          subCompetencies: ['Closures and scope', 'Promises and async', 'Type design'],
          expectedEvidence: [
            'Explains behaviour precisely rather than by recall',
            'Spots common async pitfalls',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'ui-architecture',
          name: 'Component and UI architecture',
          category: 'TECHNICAL',
          weight: 20,
          description:
            'Structures components, state and data flow so features stay easy to change.',
          subCompetencies: [
            'Component boundaries',
            'State management',
            'Data fetching and caching',
          ],
          expectedEvidence: [
            'Justifies where state lives',
            'Describes handling loading, error and empty states',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL', 'PROBLEM_SOLVING'],
        }),
        c({
          key: 'performance-accessibility',
          name: 'Performance and accessibility',
          category: 'TECHNICAL',
          weight: 15,
          description:
            'Measures and improves load and runtime performance; builds for keyboard and screen-reader users.',
          subCompetencies: ['Core Web Vitals', 'Bundle size', 'Semantic HTML and ARIA'],
          expectedEvidence: [
            'Uses measurement before optimising',
            'Names concrete accessibility practices',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'frontend-problem-solving',
          name: 'Problem solving and debugging',
          category: 'PROBLEM_SOLVING',
          weight: 15,
          description:
            'Breaks down UI problems and debugs systematically across browser, network and state.',
          subCompetencies: ['Debugging tools', 'Cross-browser issues', 'Trade-off reasoning'],
          expectedEvidence: [
            'A clear step-by-step approach to an unfamiliar bug',
            'Considers edge cases unprompted',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['PROBLEM_SOLVING'],
        }),
        c({
          key: 'testing-quality',
          name: 'Testing and quality',
          category: 'TECHNICAL',
          weight: 10,
          description: 'Tests user-visible behaviour and keeps the codebase healthy.',
          subCompetencies: ['Component tests', 'End-to-end tests', 'Code review'],
          expectedEvidence: ['Explains what is worth testing and at which level'],
          difficulty: 'EASY',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'product-collaboration',
          name: 'Collaboration with design and product',
          category: 'COMMUNICATION',
          weight: 10,
          description:
            'Turns designs and requirements into shippable work and pushes back constructively.',
          subCompetencies: ['Clarifying requirements', 'Design hand-off', 'Scoping'],
          expectedEvidence: ['An example of resolving an unclear or conflicting requirement'],
          difficulty: 'MEDIUM',
          roundTypes: ['INTRO', 'BEHAVIORAL'],
        }),
        ownership(10),
      ],
      focusSkills: [],
      probeAreas: [],
      notes: null,
    },
  },
  {
    slug: 'data-analyst',
    title: 'Data Analyst',
    family: 'DATA',
    defaultSeniority: 'JUNIOR',
    aliases: ['Business Analyst', 'BI Analyst', 'Reporting Analyst', 'Product Analyst'],
    blueprint: {
      schemaVersion: 1,
      role: {
        title: 'Data Analyst',
        family: 'DATA',
        seniority: 'JUNIOR',
        summary:
          'Answers business questions with reliable data: querying, analysis, visualisation and clear recommendations.',
      },
      competencies: [
        c({
          key: 'sql',
          name: 'SQL and data retrieval',
          category: 'TECHNICAL',
          weight: 25,
          description:
            'Writes correct, readable SQL including joins, aggregation and window functions.',
          subCompetencies: ['Joins', 'Aggregation', 'Window functions', 'Query correctness'],
          expectedEvidence: [
            'Talks through a query and its edge cases (duplicates, nulls)',
            'Checks results for sanity',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'analysis-statistics',
          name: 'Analysis and statistics',
          category: 'PROBLEM_SOLVING',
          weight: 20,
          description:
            'Chooses sound methods, understands bias and uncertainty and avoids misleading conclusions.',
          subCompetencies: [
            'Descriptive statistics',
            'A/B testing basics',
            'Correlation vs causation',
          ],
          expectedEvidence: [
            'Explains how they would validate a surprising result',
            'Names a limitation of their analysis',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL', 'PROBLEM_SOLVING'],
        }),
        c({
          key: 'business-framing',
          name: 'Business problem framing',
          category: 'PROBLEM_SOLVING',
          weight: 15,
          description: 'Turns a vague question into measurable metrics and an analysis plan.',
          subCompetencies: ['Defining metrics', 'Hypotheses', 'Prioritisation'],
          expectedEvidence: [
            'Asks clarifying questions before analysing',
            'Links the analysis to a decision',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['PROBLEM_SOLVING'],
        }),
        c({
          key: 'visualisation',
          name: 'Visualisation and storytelling',
          category: 'COMMUNICATION',
          weight: 15,
          description: 'Presents findings with appropriate charts and a clear narrative.',
          subCompetencies: ['Chart choice', 'Dashboards', 'Executive summaries'],
          expectedEvidence: [
            'Justifies a chart choice for a given audience',
            'Leads with the conclusion',
          ],
          difficulty: 'EASY',
          roundTypes: ['TECHNICAL', 'BEHAVIORAL'],
        }),
        c({
          key: 'data-quality',
          name: 'Data quality',
          category: 'TECHNICAL',
          weight: 10,
          description: 'Spots and handles missing, duplicated or inconsistent data.',
          subCompetencies: ['Validation checks', 'Cleaning', 'Documentation'],
          expectedEvidence: [
            'A concrete example of catching a data issue before it misled someone',
          ],
          difficulty: 'EASY',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'stakeholder-communication',
          name: 'Stakeholder communication',
          category: 'COMMUNICATION',
          weight: 15,
          description:
            'Works with non-technical stakeholders, manages expectations and explains uncertainty.',
          subCompetencies: ['Requirement gathering', 'Explaining uncertainty', 'Handling pushback'],
          expectedEvidence: ['An example of changing a stakeholder’s mind with data'],
          difficulty: 'MEDIUM',
          roundTypes: ['INTRO', 'BEHAVIORAL'],
        }),
      ],
      focusSkills: [],
      probeAreas: [],
      notes: null,
    },
  },
  {
    slug: 'qa-engineer',
    title: 'QA Engineer',
    family: 'QUALITY',
    defaultSeniority: 'MID',
    aliases: ['Test Engineer', 'SDET', 'Automation Tester', 'Software Tester', 'Quality Engineer'],
    blueprint: {
      schemaVersion: 1,
      role: {
        title: 'QA Engineer',
        family: 'QUALITY',
        seniority: 'MID',
        summary:
          'Designs test strategy, automates the right checks and helps the team ship with confidence.',
      },
      competencies: [
        c({
          key: 'test-strategy',
          name: 'Test strategy and design',
          category: 'PROBLEM_SOLVING',
          weight: 20,
          description: 'Decides what to test, at which level and how deeply, based on risk.',
          subCompetencies: ['Risk-based testing', 'Test pyramid', 'Boundary and equivalence cases'],
          expectedEvidence: [
            'Derives test cases from a feature description',
            'Prioritises by risk and impact',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL', 'PROBLEM_SOLVING'],
        }),
        c({
          key: 'test-automation',
          name: 'Test automation',
          category: 'TECHNICAL',
          weight: 25,
          description: 'Builds maintainable automated tests and frameworks.',
          subCompetencies: [
            'UI automation',
            'Stable selectors',
            'Flaky test handling',
            'Framework design',
          ],
          expectedEvidence: [
            'Explains how they keep suites fast and reliable',
            'Describes fixing a flaky test',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'api-integration-testing',
          name: 'API and integration testing',
          category: 'TECHNICAL',
          weight: 15,
          description: 'Tests services and integrations, including negative and contract cases.',
          subCompetencies: ['HTTP semantics', 'Contract tests', 'Test data management'],
          expectedEvidence: [
            'Lists negative cases for an endpoint',
            'Handles test data and environments sensibly',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'defect-investigation',
          name: 'Defect investigation and reporting',
          category: 'PROBLEM_SOLVING',
          weight: 15,
          description: 'Reproduces, isolates and reports defects so they get fixed quickly.',
          subCompetencies: ['Reproduction', 'Root-cause hints', 'Clear bug reports'],
          expectedEvidence: [
            'Walks through isolating an intermittent bug',
            'Describes a high-quality bug report',
          ],
          difficulty: 'MEDIUM',
          roundTypes: ['PROBLEM_SOLVING'],
        }),
        c({
          key: 'ci-quality-gates',
          name: 'CI and quality gates',
          category: 'DOMAIN',
          weight: 10,
          description: 'Integrates testing into delivery pipelines with useful signals.',
          subCompetencies: ['CI pipelines', 'Coverage and reporting', 'Release checks'],
          expectedEvidence: ['Explains which checks block a release and why'],
          difficulty: 'EASY',
          roundTypes: ['TECHNICAL'],
        }),
        c({
          key: 'quality-collaboration',
          name: 'Collaboration and quality advocacy',
          category: 'COMMUNICATION',
          weight: 15,
          description: 'Works with developers and product to prevent defects, not just find them.',
          subCompetencies: ['Shift-left practices', 'Negotiating scope', 'Clear communication'],
          expectedEvidence: ['An example of influencing a team to improve quality'],
          difficulty: 'MEDIUM',
          roundTypes: ['INTRO', 'BEHAVIORAL'],
        }),
      ],
      focusSkills: [],
      probeAreas: [],
      notes: null,
    },
  },
];

export interface SeedTemplate {
  key: string;
  content: TemplateContent;
}

const commonPolicies = {
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
} as const satisfies Partial<TemplateContent>;

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    key: 'standard-practice',
    content: {
      name: 'Standard practice interview',
      description:
        'A realistic 30-minute interview: introduction, technical depth, problem solving and behavioural questions.',
      modes: ['TEXT', 'VOICE', 'VIDEO'],
      rounds: [
        {
          type: 'INTRO',
          durationSec: 180,
          questionCount: 2,
          difficulty: 'EASY',
          followUpDepth: 0,
          minEvidence: 0,
        },
        {
          type: 'TECHNICAL',
          durationSec: 720,
          questionCount: 4,
          difficulty: 'ADAPTIVE',
          followUpDepth: 2,
          minEvidence: 3,
        },
        {
          type: 'PROBLEM_SOLVING',
          durationSec: 540,
          questionCount: 2,
          difficulty: 'ADAPTIVE',
          followUpDepth: 2,
          minEvidence: 2,
        },
        {
          type: 'BEHAVIORAL',
          durationSec: 360,
          questionCount: 2,
          difficulty: 'MEDIUM',
          followUpDepth: 1,
          minEvidence: 1,
        },
        {
          type: 'WRAP_UP',
          durationSec: 120,
          questionCount: 1,
          difficulty: 'EASY',
          followUpDepth: 0,
          minEvidence: 0,
        },
      ],
      ...commonPolicies,
    },
  },
  {
    key: 'quick-practice',
    content: {
      name: 'Quick practice interview',
      description: 'A focused 15-minute session: one technical round and one behavioural round.',
      modes: ['TEXT', 'VOICE', 'VIDEO'],
      rounds: [
        {
          type: 'INTRO',
          durationSec: 120,
          questionCount: 1,
          difficulty: 'EASY',
          followUpDepth: 0,
          minEvidence: 0,
        },
        {
          type: 'TECHNICAL',
          durationSec: 480,
          questionCount: 3,
          difficulty: 'ADAPTIVE',
          followUpDepth: 1,
          minEvidence: 2,
        },
        {
          type: 'BEHAVIORAL',
          durationSec: 240,
          questionCount: 1,
          difficulty: 'MEDIUM',
          followUpDepth: 1,
          minEvidence: 1,
        },
        {
          type: 'WRAP_UP',
          durationSec: 60,
          questionCount: 1,
          difficulty: 'EASY',
          followUpDepth: 0,
          minEvidence: 0,
        },
      ],
      ...commonPolicies,
    },
  },
];

export const DEFAULT_TEMPLATE_KEY = 'standard-practice';
