import { create } from 'qrcode';
import { useMemo } from 'react';

/** Quiet zone around the code, in modules (scanners need a light border). */
const MARGIN = 2;

/**
 * The path of a QR code's dark modules, one unit square per module, offset
 * by the quiet zone. Null when the text cannot be encoded.
 */
export function qrPath(text: string): { size: number; d: string } | null {
  try {
    const { modules } = create(text, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
      }
    }
    return { size: modules.size + MARGIN * 2, d };
  } catch {
    return null;
  }
}

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
