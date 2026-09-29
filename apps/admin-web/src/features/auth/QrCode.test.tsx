import { create } from 'qrcode';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode, qrPath } from './QrCode';

const URI =
  'otpauth://totp/CareerPilot%20Interview%20Admin:root%40codebegun.com?secret=JBSWY3DPEHPK3PXP&issuer=CareerPilot%20Interview%20Admin';

describe('QR code', () => {
  it('draws one square per dark module inside a quiet zone', () => {
    const { modules } = create(URI, { errorCorrectionLevel: 'M' });
    const dark = Array.from(modules.data).filter(Boolean).length;
    const qr = qrPath(URI)!;
    expect(qr.size).toBe(modules.size + 4);
    expect(qr.d.match(/M/g)).toHaveLength(dark);
    // The top-left finder pattern starts right after the quiet zone.
    expect(qr.d.startsWith('M2 2h1v1h-1z')).toBe(true);
  });

  it('renders an accessible SVG in the current text colour, or nothing if it cannot encode', () => {
    const { rerender, container } = render(<QrCode text={URI} label="Scan me" />);
    const svg = screen.getByRole('img', { name: 'Scan me' });
    expect(svg.querySelector('path')).toHaveAttribute('fill', 'currentColor');
    rerender(<QrCode text={'x'.repeat(5000)} label="Too long" />);
    expect(container).toBeEmptyDOMElement();
  });
});
