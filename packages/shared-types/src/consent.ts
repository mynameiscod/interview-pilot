import { z } from 'zod';

/**
 * Consent (Phase 8). Consent texts are append-only versions per type and
 * locale, edited by admins (legal review required before launch). A
 * candidate's decision is recorded against the exact text version, with a
 * hashed IP and the user agent, in `consents`.
 */

export const ConsentType = z.enum([
  /** Answers are sent to speech providers to transcribe them and questions are read aloud. */
  'VOICE_PROCESSING',
  /** The camera and microphone are recorded and stored for the retention period. */
  'RECORDING',
  /** Tab switches, focus changes and pastes are noted (observations, never judgements). */
  'INTEGRITY',
]);
export type ConsentType = z.infer<typeof ConsentType>;

export const ConsentLocale = z.enum(['en', 'hi', 'te']);
export type ConsentLocale = z.infer<typeof ConsentLocale>;

export const ConsentTextSummary = z.object({
  id: z.string(),
  type: ConsentType,
  version: z.number().int(),
  locale: ConsentLocale,
  title: z.string(),
  body: z.string(),
  active: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ConsentTextSummary = z.infer<typeof ConsentTextSummary>;

export const CreateConsentTextBody = z.object({
  type: ConsentType,
  locale: ConsentLocale,
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(20).max(8000),
  reason: z.string().trim().min(3).max(300),
});
export type CreateConsentTextBody = z.infer<typeof CreateConsentTextBody>;

export const ActivateConsentTextBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type ActivateConsentTextBody = z.infer<typeof ActivateConsentTextBody>;

/** One consent an interview asks for, with the candidate's current decision. */
export const SessionConsentItem = z.object({
  type: ConsentType,
  /** Required consents must be accepted to start; optional ones switch a feature off when declined. */
  required: z.boolean(),
  text: z.object({
    id: z.string(),
    version: z.number().int(),
    locale: ConsentLocale,
    title: z.string(),
    body: z.string(),
  }),
  /** The decision on this exact text version, or null. */
  decision: z.object({ accepted: z.boolean(), at: z.iso.datetime() }).nullable(),
});
export type SessionConsentItem = z.infer<typeof SessionConsentItem>;

export const SessionConsents = z.object({
  items: z.array(SessionConsentItem),
  /** Every item has a decision on its current text and every required one is accepted. */
  complete: z.boolean(),
});
export type SessionConsents = z.infer<typeof SessionConsents>;

export const ConsentDecisionBody = z.object({
  decisions: z
    .array(z.object({ consentTextId: z.string().min(1).max(64), accepted: z.boolean() }))
    .min(1)
    .max(5),
});
export type ConsentDecisionBody = z.infer<typeof ConsentDecisionBody>;

/** A candidate's consent history (privacy page). */
export const UserConsentEntry = z.object({
  id: z.string(),
  type: ConsentType,
  version: z.number().int(),
  locale: ConsentLocale,
  title: z.string(),
  accepted: z.boolean(),
  at: z.iso.datetime(),
  sessionId: z.string().nullable(),
});
export type UserConsentEntry = z.infer<typeof UserConsentEntry>;

/** The consents an interview asks for, from its mode and the template's proctoring policy. */
export function consentRequirements(
  mode: 'TEXT' | 'VOICE' | 'VIDEO',
  policy: { recording: 'OFF' | 'OPTIONAL' | 'REQUIRED'; tabSwitchTracking: boolean },
): { type: ConsentType; required: boolean }[] {
  const out: { type: ConsentType; required: boolean }[] = [];
  if (mode !== 'TEXT') out.push({ type: 'VOICE_PROCESSING', required: true });
  if (mode === 'VIDEO' && policy.recording !== 'OFF') {
    out.push({ type: 'RECORDING', required: policy.recording === 'REQUIRED' });
  }
  if (policy.tabSwitchTracking) out.push({ type: 'INTEGRITY', required: true });
  return out;
}
