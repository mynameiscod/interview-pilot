/** TEST SUPPORT ONLY: recordings and consent fixtures shared by the admin privacy tests. */
import type { AdminIntegrityEvent, AdminMediaAsset, ConsentTextSummary } from '@cbi/shared-types';

const now = new Date().toISOString();

export const mediaAsset = (overrides: Partial<AdminMediaAsset> = {}): AdminMediaAsset => ({
  id: 'med1',
  sessionId: 'ses1',
  kind: 'CANDIDATE_VIDEO',
  mimeType: 'video/webm',
  status: 'COMPLETE',
  segmentCount: 60,
  expectedSegments: 60,
  missingSegments: [],
  bytes: 52_428_800,
  durationMs: 600_000,
  retentionExpiresAt: '2026-12-23T10:00:00.000Z',
  deletion: { status: 'NONE', at: null, reason: null },
  createdAt: now,
  userId: 'user-7',
  userEmail: 'asha@example.com',
  interviewTitle: 'Backend Engineer mock',
  ...overrides,
});

export const integrityEvent = (
  overrides: Partial<AdminIntegrityEvent> = {},
): AdminIntegrityEvent => ({
  type: 'TAB_HIDDEN',
  at: now,
  offsetSec: 130,
  value: null,
  ...overrides,
});

export const consentText = (overrides: Partial<ConsentTextSummary> = {}): ConsentTextSummary => ({
  id: 'ct-rec-en-2',
  type: 'RECORDING',
  version: 2,
  locale: 'en',
  title: 'Recording your interview',
  body: 'We record your camera and microphone during this interview and keep the video for 90 days.',
  active: true,
  reason: 'Initial wording',
  createdAt: now,
  ...overrides,
});
