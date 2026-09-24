import type { InterviewSummary } from '@cbi/shared-types';
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
    }
  }
  return errorMessage(t, err);
}

/** Where an interview in this state is best continued. */
export function interviewPath(interview: Pick<InterviewSummary, 'id' | 'state'>): string {
  const base = `/app/interviews/${interview.id}`;
  return interview.state === 'READY' ? `${base}/setup` : `${base}/analysis`;
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
