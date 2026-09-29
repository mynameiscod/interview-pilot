import { create } from 'qrcode';

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
