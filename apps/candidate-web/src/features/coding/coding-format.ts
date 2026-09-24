import type { CodingSubmission } from '@cbi/shared-types';
import type { TFunction } from 'i18next';

/** The submission's outcome in one sentence. */
export function submissionMessage(t: TFunction, submission: CodingSubmission): string {
  if (submission.judgeUnavailable || !submission.result) {
    return t('coding.submitted.judgeUnavailable');
  }
  return t('coding.submitted.summary', {
    passed: submission.result.passed,
    total: submission.result.total,
  });
}
