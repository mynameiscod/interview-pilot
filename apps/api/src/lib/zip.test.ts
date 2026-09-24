import { describe, expect, it } from 'vitest';
import { buildZip, readZip } from './zip.js';

describe('buildZip', () => {
  it('round-trips entries with UTF-8 names', () => {
    const entries = [
      { name: 'results.csv', data: Buffer.from('a,b\n1,2\n') },
      { name: 'reports/ప్రియ-1.json', data: Buffer.from(JSON.stringify({ x: 'y'.repeat(5000) })) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const zip = buildZip(entries);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const back = readZip(zip);
    expect([...back.keys()]).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(back.get(e.name)).toEqual(e.data);
  });
});
