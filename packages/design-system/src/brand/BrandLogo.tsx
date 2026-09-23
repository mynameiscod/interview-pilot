import { useState } from 'react';
import { BRAND_ASSETS, type BrandAssetKey } from './brand-assets';
import { BrandLogoPlaceholder } from './BrandLogoPlaceholder';

export interface BrandLogoProps {
  asset?: BrandAssetKey;
  className?: string;
  /** Overrides the registry alt text, e.g. when the logo is also a home link. */
  alt?: string;
}

/**
 * Renders an official brand asset from the central registry. If the file is
 * not present (404, or an SPA fallback page that fails to decode as an image),
 * it renders the clearly-marked development placeholder instead.
 */
export function BrandLogo({ asset = 'codebegunLogo', className, alt }: BrandLogoProps) {
  const entry = BRAND_ASSETS[asset];
  const [failed, setFailed] = useState(false);
  const label = alt ?? entry.alt;

  if (failed) {
    return <BrandLogoPlaceholder label={label} className={className} />;
  }

  return (
    <img
      src={entry.path}
      alt={label}
      className={['cb-brand-logo', className].filter(Boolean).join(' ')}
      onError={() => setFailed(true)}
      decoding="async"
    />
  );
}
