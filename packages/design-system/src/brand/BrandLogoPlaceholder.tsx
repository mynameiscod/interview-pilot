export interface BrandLogoPlaceholderProps {
  /** Accessible name of the asset that is missing, e.g. "CodeBegun". */
  label: string;
  className?: string;
}

/**
 * DEVELOPMENT PLACEHOLDER — NOT A LOGO.
 *
 * Rendered only when an official brand file is missing. It is intentionally
 * styled as a "missing asset" marker and must never be treated as, or styled
 * to resemble, CodeBegun artwork. Production release is blocked while any
 * placeholder is visible (see docs/product/brand-assets-required.md).
 */
export function BrandLogoPlaceholder({ label, className }: BrandLogoPlaceholderProps) {
  return (
    <span
      className={['cb-brand-placeholder', className].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
      data-brand-placeholder="true"
      title="Official logo file not supplied yet (development placeholder)"
    >
      <span aria-hidden="true">[logo pending]</span>
    </span>
  );
}
