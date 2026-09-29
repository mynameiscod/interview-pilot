import type { Logger } from '@cbi/config';
import { mongoose, UserProfileModel } from '@cbi/db';
import { redactedTotal, redactPii, type RedactOptions } from '@cbi/documents';

/** Names the candidate is known by, to mask in their documents before AI calls. */
export async function knownNames(userId: mongoose.Types.ObjectId | string): Promise<string[]> {
  const profile = await UserProfileModel.findOne(
    { userId: new mongoose.Types.ObjectId(String(userId)) },
    { displayName: 1 },
  ).lean();
  return profile?.displayName ? [profile.displayName] : [];
}

/**
 * Masks personal data in text bound for an AI provider and logs how much was
 * masked (counts only). The stored text is not changed.
 */
export function redactForAi(
  logger: Logger,
  text: string,
  opts: RedactOptions & { what: string; userId?: string },
): string {
  if (!text) return text;
  const { text: redacted, counts } = redactPii(text, opts);
  if (redactedTotal(counts) > 0) {
    logger.info(
      { metric: 'ai.pii_redacted', what: opts.what, userId: opts.userId, counts },
      'personal data masked before an AI call',
    );
  }
  return redacted;
}
