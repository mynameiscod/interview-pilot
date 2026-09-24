import type { InterviewSummary, PublicCampaign } from '@cbi/shared-types';

export function makePublicCampaign(overrides: Partial<PublicCampaign> = {}): PublicCampaign {
  return {
    name: 'Backend hiring 2026',
    companyName: 'Acme Labs',
    roleTitle: 'Backend Developer',
    assesses: ['API design', 'Databases'],
    totalDurationSec: 1800,
    modes: ['TEXT', 'VOICE'],
    languages: ['en', 'hi'],
    recording: 'OFF',
    observations: true,
    candidateSeesReport: true,
    sponsored: false,
    window: { startAt: '2026-09-01T04:30:00.000Z', endAt: '2026-10-31T12:30:00.000Z' },
    closedReason: null,
    joinedInterviewId: null,
    ...overrides,
  };
}

type Campaign = NonNullable<InterviewSummary['campaign']>;

/** The `campaign` block of a campaign interview's summary. */
export function makeInterviewCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'cmp1',
    name: 'Backend hiring 2026',
    companyName: 'Acme Labs',
    sponsored: true,
    reportVisible: true,
    modes: ['TEXT', 'VOICE'],
    languages: ['en', 'hi'],
    ...overrides,
  };
}
