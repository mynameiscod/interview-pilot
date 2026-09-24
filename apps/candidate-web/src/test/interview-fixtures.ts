import type {
  Extraction,
  InterviewSummary,
  JobTargetSummary,
  ResumeSummary,
  RoleAnalysis,
} from '@cbi/shared-types';

const NOW = '2026-09-20T10:00:00.000Z';

export function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    status: 'READY',
    errorCode: null,
    warnings: [],
    parser: 'pdf',
    ocrUsed: false,
    charCount: 4000,
    completedAt: NOW,
    ...overrides,
  };
}

export function makeResume(overrides: Partial<ResumeSummary> = {}): ResumeSummary {
  return {
    id: 'res1',
    originalName: 'asha-resume.pdf',
    mime: 'application/pdf',
    size: 120_000,
    extraction: makeExtraction(),
    structured: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeJobTarget(overrides: Partial<JobTargetSummary> = {}): JobTargetSummary {
  return {
    id: 'job1',
    source: 'PASTE',
    url: null,
    originalName: null,
    extraction: makeExtraction({ status: 'PENDING', completedAt: null }),
    structured: null,
    company: null,
    companyName: null,
    role: null,
    roleTitle: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeAnalysis(overrides: Partial<RoleAnalysis> = {}): RoleAnalysis {
  return {
    detectedRole: {
      title: 'Backend Developer',
      family: 'ENGINEERING',
      seniority: 'JUNIOR',
      confidence: 0.82,
    },
    matchedRole: { id: 'role1', title: 'Backend Developer' },
    blueprint: { id: 'bp1', origin: 'AI_GENERATED', version: 1 },
    skills: [
      { name: 'Node.js', weight: 40, sources: ['JD', 'RESUME'], inResume: true },
      { name: 'SQL', weight: 25, sources: ['JD'], inResume: false },
    ],
    resumeHighlights: ['Built a REST API used by 2,000 students'],
    gaps: ['No production database experience shown'],
    inputs: { resume: true, jd: true, companyPatterns: false },
    plannedRounds: [
      { type: 'INTRO', durationSec: 300, focus: [] },
      { type: 'TECHNICAL', durationSec: 1200, focus: ['Node.js', 'SQL'] },
    ],
    totalDurationSec: 1500,
    analyzedAt: NOW,
    ...overrides,
  };
}

export function makeInterview(overrides: Partial<InterviewSummary> = {}): InterviewSummary {
  return {
    id: 'int1',
    state: 'READY',
    mode: 'TEXT',
    language: 'auto',
    jobTargetId: 'job1',
    resumeId: 'res1',
    title: 'Backend Developer',
    companyName: 'Acme Labs',
    template: {
      id: 'tpl1',
      name: 'Standard practice',
      creditCost: 1,
      modes: ['TEXT', 'VOICE'],
      totalDurationSec: 1800,
    },
    analysis: makeAnalysis(),
    failure: null,
    startedAt: null,
    endedAt: null,
    credit: 'NONE',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
