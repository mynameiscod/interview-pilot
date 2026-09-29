/**
 * Structure of the public landing page. The copy lives under `landing.*` in the
 * locale files; the build-time prerender (src/seo) reads the same keys so the
 * FAQPage structured data always matches the English FAQ on the page.
 */

export const LANDING_STEPS = [
  { key: 'step1', icon: 'bi-file-earmark-person' },
  { key: 'step2', icon: 'bi-chat-square-text' },
  { key: 'step3', icon: 'bi-clipboard-data' },
] as const;

export const LANDING_FEATURES = [
  { key: 'tailored', icon: 'bi-bullseye' },
  { key: 'modes', icon: 'bi-mic' },
  { key: 'coding', icon: 'bi-code-slash' },
  { key: 'report', icon: 'bi-clipboard-data' },
  { key: 'progress', icon: 'bi-graph-up-arrow' },
  { key: 'proof', icon: 'bi-share' },
] as const;

export const LANDING_TRUST = [
  { key: 'consent', icon: 'bi-ui-checks' },
  { key: 'recordings', icon: 'bi-clock-history' },
  { key: 'payments', icon: 'bi-lock' },
] as const;

/** FAQ entries, in display order: `landing.faq.<key>Q` / `landing.faq.<key>A`. */
export const LANDING_FAQ = ['free', 'need', 'languages', 'assessed', 'private', 'credits'] as const;
