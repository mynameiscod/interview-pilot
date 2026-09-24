import { isSpokenMode, type InterviewState, type InterviewSummary } from '@cbi/shared-types';
import { ApiClientError, errorMessage } from '@cbi/web-core';
import type { TFunction } from 'i18next';

/** Shown to candidates; the API enforces the same limit (UPLOAD_MAX_MB). */
export const MAX_UPLOAD_MB = 8;
export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt'];
export const ACCEPT_ATTRIBUTE = [
  ...ACCEPTED_EXTENSIONS,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
].join(',');

/** Checks a picked file before uploading it; returns a translated problem or null. */
export function fileProblem(t: TFunction, file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return t('inputs.fileWrongType');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024)
    return t('inputs.fileTooLarge', { mb: MAX_UPLOAD_MB });
  if (file.size === 0) return t('inputs.fileEmpty');
  return null;
}

/** API errors from uploads, job targets and interviews, in the candidate's language. */
export function inputErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'UNSUPPORTED_MEDIA_TYPE':
        return t('inputs.fileWrongType');
      case 'PAYLOAD_TOO_LARGE':
        return t('inputs.fileTooLarge', { mb: MAX_UPLOAD_MB });
      case 'CONFLICT':
        return t('inputs.conflict');
      case 'INVALID_STATE':
        return t('inputs.invalidState');
      case 'AI_UNAVAILABLE':
      case 'SERVICE_UNAVAILABLE':
        return t('inputs.serviceUnavailable');
      case 'CAMPAIGN_CLOSED':
        return t('campaign.errors.closed');
    }
  }
  return errorMessage(t, err);
}

/** An interview the candidate can (re)enter the room for. */
export const LIVE_STATES: readonly InterviewState[] = [
  'ACTIVE',
  'ROUND_TRANSITION',
  'RECONNECTING',
  'PAUSED',
];

/** An interview that has ended; its outcome is shown on the complete screen. */
export const ENDED_STATES: readonly InterviewState[] = [
  'COMPLETING',
  'PROCESSING',
  'REPORT_READY',
  'EXPIRED',
];

export const isLive = (state: InterviewState) => LIVE_STATES.includes(state);

/** True when the interview ran (or was started) and is now over. */
export const isEnded = (
  interview: Pick<InterviewSummary, 'state'> & { startedAt?: string | null },
) =>
  ENDED_STATES.includes(interview.state) ||
  (interview.state === 'FAILED' && Boolean(interview.startedAt));

/**
 * False when a campaign keeps the report from the candidate (the company decides);
 * such interviews never link to or load the report.
 */
export const reportVisible = (interview: {
  campaign?: Pick<NonNullable<InterviewSummary['campaign']>, 'reportVisible'> | null;
}) => interview.campaign?.reportVisible !== false;

/** Where an interview in this state is best continued. */
export function interviewPath(
  interview: Pick<InterviewSummary, 'id' | 'state'> & {
    startedAt?: string | null;
    campaign?: Pick<NonNullable<InterviewSummary['campaign']>, 'reportVisible'> | null;
  },
): string {
  const base = `/app/interviews/${interview.id}`;
  if (interview.state === 'READY') return `${base}/setup`;
  if (interview.state === 'READY_TO_START') return `${base}/start`;
  if (isLive(interview.state)) return `${base}/room`;
  if (interview.state === 'REPORT_READY' && reportVisible(interview))
    return `/app/reports/${interview.id}`;
  if (isEnded(interview)) return `${base}/complete`;
  return `${base}/analysis`;
}

/** Errors from starting an interview, in the candidate's language. */
export function startErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'INSUFFICIENT_CREDITS') return t('start.errors.noCredits');
    if (err.code === 'CONFLICT') return t('start.errors.inProgress');
    if (err.code === 'INVALID_STATE') return t('start.errors.invalidState');
  }
  return inputErrorMessage(t, err);
}

export function formatMinutes(t: TFunction, seconds: number): string {
  return t('interview.minutes', { count: Math.max(1, Math.round(seconds / 60)) });
}

export function formatDate(lng: string | undefined, iso: string): string {
  try {
    return new Intl.DateTimeFormat(lng, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return new Date(iso).toDateString();
  }
}

/**
 * The next step before starting: voice and video interviews check the
 * devices (and ask for consent there); any interview with consents still
 * pending asks for them; otherwise straight to the start screen.
 */
export function nextStepPath(
  interview: Pick<InterviewSummary, 'id' | 'mode' | 'voice' | 'consentsPending'>,
): string {
  const base = `/app/interviews/${interview.id}`;
  if (isSpokenMode(interview.mode) && interview.voice?.ready !== true)
    return `${base}/device-check`;
  if (interview.consentsPending) return `${base}/consent`;
  return `${base}/start`;
}
