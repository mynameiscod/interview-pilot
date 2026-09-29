import { useMemo } from 'react';
import { qrPath } from './qr-path';

/**
 * A QR code drawn client-side as SVG (the text never leaves the browser):
 * dark modules in the current text colour on the page's white surface.
 * Renders nothing when the text cannot be encoded; callers keep a text fallback.
 */
export function QrCode({ text, label, px = 176 }: { text: string; label: string; px?: number }) {
  const qr = useMemo(() => qrPath(text), [text]);
  if (!qr) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={px}
      height={px}
      shapeRendering="crispEdges"
      className="d-block bg-white text-dark border cb-border rounded-2"
    >
      <path d={qr.d} fill="currentColor" />
    </svg>
  );
}
