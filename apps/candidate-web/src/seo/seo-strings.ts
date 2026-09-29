import en from '../i18n/locales/en/common.json' with { type: 'json' };
import { LANDING_FAQ } from '../pages/landing-content.ts';
import type { SeoStrings } from './seo.ts';

/**
 * English page metadata, taken from the same locale keys the pages render, so
 * the prerendered FAQPage data cannot drift from the visible FAQ.
 */
export function englishSeoStrings(): SeoStrings {
  return {
    productName: en.app.productName,
    endorsement: en.app.endorsement,
    tagline: en.app.tagline,
    homeDescription: en.landing.hero.subtitle,
    pricingTitle: en.pricing.title,
    pricingDescription: en.pricing.subtitle,
    faq: LANDING_FAQ.map((key) => ({
      question: en.landing.faq[`${key}Q`],
      answer: en.landing.faq[`${key}A`],
    })),
  };
}
