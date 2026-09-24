import type {
  ConsentDecisionBody,
  ConsentType,
  SessionConsentItem,
  SessionConsents,
} from '@cbi/shared-types';

const AT = '2026-09-24T10:00:00.000Z';

const TEXTS: Record<ConsentType, { title: string; body: string }> = {
  VOICE_PROCESSING: {
    title: 'Voice processing',
    body: 'Your spoken answers are sent to speech providers to turn them into text.\n\nYour audio is not stored.',
  },
  RECORDING: {
    title: 'Recording',
    body: 'Your camera and microphone are recorded and kept for 30 days.\n\nYou can delete the recording at any time.',
  },
  INTEGRITY: {
    title: 'Session observations',
    body: 'Tab switches, focus changes and pastes are noted.\n\nThey are observations, never judgements.',
  },
  CAMPAIGN_SHARING: {
    title: 'Sharing with the company',
    body: 'Your answers and report are shared with the company that invited you.\n\nThey use them to decide on next steps.',
  },
};

export function makeConsentItem(
  type: ConsentType,
  overrides: Partial<SessionConsentItem> = {},
): SessionConsentItem {
  return {
    type,
    required: type !== 'RECORDING',
    text: { id: `ct-${type.toLowerCase()}`, version: 1, locale: 'en', ...TEXTS[type] },
    decision: null,
    ...overrides,
  };
}

export function makeConsents(items: SessionConsentItem[]): SessionConsents {
  return {
    items,
    complete: items.every((i) => i.decision && (i.decision.accepted || !i.required)),
  };
}

/** The server's answer to a decision: the same items with the decisions applied. */
export function decide(consents: SessionConsents, body: unknown): SessionConsents {
  const { decisions } = body as ConsentDecisionBody;
  return makeConsents(
    consents.items.map((item) => {
      const d = decisions.find((x) => x.consentTextId === item.text.id);
      return d ? { ...item, decision: { accepted: d.accepted, at: AT } } : item;
    }),
  );
}
