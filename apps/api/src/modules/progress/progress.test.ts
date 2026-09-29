import { CERTIFICATE_CODE_PATTERN } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { blockedDuringMaintenance } from '../../middleware/maintenance.js';
import { certificateCode, verifyPath } from '../ops/certificates.service.js';
import { planItems } from './progress.service.js';

describe('certificate codes', () => {
  it('are readable, unambiguous and match the public pattern', () => {
    for (let i = 0; i < 200; i++) expect(certificateCode()).toMatch(CERTIFICATE_CODE_PATTERN);
    expect(certificateCode(Buffer.alloc(12, 0))).toBe('CPI-2222-2222-2222');
    expect(certificateCode(Buffer.alloc(12, 31))).toBe('CPI-ZZZZ-ZZZZ-ZZZZ');
    expect(verifyPath('CPI-2222-2222-2222')).toBe('/verify/CPI-2222-2222-2222');
  });
});

describe('plan items', () => {
  it('are numbered per bucket in plan order', () => {
    const items = planItems({
      plan: {
        next24h: [
          { action: 'a1', why: 'w', dimensionKey: 'sql' },
          { action: 'a2', why: 'w', dimensionKey: null },
        ],
        next3Days: [{ action: 'b1', why: 'w', dimensionKey: null }],
        next7Days: [{ action: 'c1', why: 'w', dimensionKey: 'apis' }],
      },
    });
    expect(items.map((i) => [i.id, i.bucket, i.action])).toEqual([
      ['next24h.0', 'next24h', 'a1'],
      ['next24h.1', 'next24h', 'a2'],
      ['next3Days.0', 'next3Days', 'b1'],
      ['next7Days.0', 'next7Days', 'c1'],
    ]);
  });
});

describe('maintenance', () => {
  it('always lets candidates unsubscribe from emails', () => {
    expect(blockedDuringMaintenance('POST', '/email/unsubscribe')).toBe(false);
    expect(blockedDuringMaintenance('POST', '/drills')).toBe(true);
    expect(blockedDuringMaintenance('PUT', '/users/me/progress/plan-items')).toBe(true);
  });
});
