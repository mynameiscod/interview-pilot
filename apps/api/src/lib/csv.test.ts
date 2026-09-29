import { describe, expect, it } from 'vitest';
import { csvCell, csvLine } from './csv.js';

describe('csv cells', () => {
  it('leaves plain values alone and blanks null and undefined', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises text a spreadsheet would run as a formula', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(s).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('joins a line with CRLF', () => {
    expect(csvLine(['a', null, '=b', 1])).toBe("a,,'=b,1\r\n");
  });
});
