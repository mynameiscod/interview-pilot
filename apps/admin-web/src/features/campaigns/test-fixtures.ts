/** TEST SUPPORT ONLY: campaign and review fixtures shared by the admin campaign tests. */
import type {
  AdminInterviewDetail,
  AdminInterviewRow,
  CampaignResultRow,
  CampaignResults,
  CampaignSummary,
  ScoreRevisionSummary,
} from '@cbi/shared-types';

const now = new Date().toISOString();

export const CAMPAIGN_ID = '64b000000000000000000001';

export const campaign = (overrides: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: CAMPAIGN_ID,
  name: 'Globex backend hiring',
  status: 'DRAFT',
  companyId: 'c1',
  companyName: 'Globex',
  role: { id: 'r1', title: 'Backend Engineer' },
  blueprint: { id: 'b1', version: 3 },
  template: { id: 't1', key: 'standard-technical', version: 2, name: 'Standard technical' },
  jobDescription: null,
  modes: ['TEXT'],
  languages: ['auto', 'en'],
  window: { startAt: now, endAt: null },
  maxCandidates: 50,
  joined: 12,
  proctoring: { recording: 'OFF', tabSwitchTracking: true },
  candidateSeesReport: true,
  sponsoredCredits: { total: 40, used: 9 },
  tokenHint: 'k3Xq',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

export const resultRow = (overrides: Partial<CampaignResultRow> = {}): CampaignResultRow => ({
  applicationId: 'app1',
  interviewId: 'int1',
  candidate: { userId: 'user-7', name: 'Asha Rao', email: 'asha@example.com' },
  status: 'COMPLETED',
  joinedAt: now,
  completedAt: now,
  overall: 78,
  band: 'READY_WITH_GAPS',
  confidence: 'HIGH',
  scoreRevision: 0,
  dimensions: { 'api-design': 82, debugging: 71 },
  flagged: false,
  ...overrides,
});

export const results = (rows: CampaignResultRow[] = [resultRow()]): CampaignResults => ({
  campaignId: CAMPAIGN_ID,
  dimensions: [
    { key: 'api-design', name: 'API design' },
    { key: 'debugging', name: 'Debugging' },
  ],
  rows,
});

export const interviewRow = (overrides: Partial<AdminInterviewRow> = {}): AdminInterviewRow => ({
  id: 'int1',
  state: 'REPORT_READY',
  mode: 'TEXT',
  title: 'Backend Engineer interview',
  candidate: { userId: 'user-7', email: 'asha@example.com' },
  campaign: { id: CAMPAIGN_ID, name: 'Globex backend hiring' },
  overall: 78,
  band: 'READY_WITH_GAPS',
  scoreRevision: 0,
  flag: { flagged: false, reason: null, by: null, at: null },
  startedAt: now,
  endedAt: now,
  ...overrides,
});

export const scoreRevision = (
  overrides: Partial<ScoreRevisionSummary> = {},
): ScoreRevisionSummary => ({
  revision: 0,
  overall: 78,
  band: 'READY_WITH_GAPS',
  dimensions: [
    { key: 'api-design', name: 'API design', weight: 60, score: 82, note: null },
    { key: 'debugging', name: 'Debugging', weight: 40, score: 71, note: null },
  ],
  createdBy: 'ai',
  reason: null,
  createdAt: now,
  ...overrides,
});

export const interviewDetail = (
  overrides: Partial<AdminInterviewDetail> = {},
): AdminInterviewDetail => ({
  ...interviewRow(),
  turns: [
    {
      seq: 1,
      roundType: 'TECHNICAL',
      question: 'How would you version a public API?',
      answer: 'With a version prefix in the path and a deprecation window.',
      answerSource: 'TEXT',
      coding: false,
    },
  ],
  evidence: [
    {
      id: 'ev1',
      questionId: 'q1',
      competencyKey: 'api-design',
      claim: 'Explains versioning trade-offs',
      strength: 2,
      confidence: 0.8,
      practical: true,
      uncertainty: null,
    },
  ],
  scoreRevisions: [scoreRevision()],
  reportRevisions: [
    {
      revision: 0,
      scoreRevision: 0,
      candidateVisible: true,
      pdfStatus: 'READY',
      generatedAt: now,
    },
  ],
  aiCostMicros: 42_000,
  ...overrides,
});
