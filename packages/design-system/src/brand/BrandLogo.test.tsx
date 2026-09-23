import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BRAND_ASSETS } from './brand-assets';
import { BrandLogo } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the official asset path from the central registry', () => {
    render(<BrandLogo />);
    const img = screen.getByRole('img', { name: 'CodeBegun' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', BRAND_ASSETS.codebegunLogo.path);
  });

  it('falls back to the marked development placeholder when the file is missing', () => {
    render(<BrandLogo asset="careerpilotInterviewLogo" />);
    fireEvent.error(screen.getByRole('img', { name: 'CareerPilot Interview' }));
    const placeholder = screen.getByRole('img', { name: 'CareerPilot Interview' });
    expect(placeholder.tagName).toBe('SPAN');
    expect(placeholder).toHaveAttribute('data-brand-placeholder', 'true');
    expect(placeholder).toHaveTextContent('[logo pending]');
  });

  it('keeps every registered asset under /brand/', () => {
    for (const entry of Object.values(BRAND_ASSETS)) {
      expect(entry.path).toMatch(/^\/brand\/[a-z0-9-]+\.svg$/);
    }
  });
});
