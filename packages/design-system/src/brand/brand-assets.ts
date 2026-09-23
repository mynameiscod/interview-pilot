/**
 * Central registry of brand asset locations. This is the ONLY place brand
 * file paths are defined. Each web app serves these files from its own
 * `public/brand/` directory.
 *
 * To go to production, drop the official files at these paths. No code change
 * is needed: <BrandLogo> renders the file when it loads and falls back to the
 * development placeholder only when the file is missing.
 *
 * Official artwork has NOT been supplied yet; see
 * docs/product/brand-assets-required.md. Never add generated or redrawn
 * logo artwork here.
 */
export const BRAND_ASSETS = {
  codebegunLogo: {
    path: '/brand/codebegun-logo.svg',
    alt: 'CodeBegun',
  },
  codebegunLogoReversed: {
    path: '/brand/codebegun-logo-reversed.svg',
    alt: 'CodeBegun',
  },
  careerpilotInterviewLogo: {
    path: '/brand/careerpilot-interview-logo.svg',
    alt: 'CareerPilot Interview',
  },
} as const;

export type BrandAssetKey = keyof typeof BRAND_ASSETS;

/** Product naming approved for Phase 0. */
export const BRAND_NAMES = {
  company: 'CodeBegun',
  product: 'CareerPilot Interview',
  endorsement: 'by CodeBegun',
} as const;
