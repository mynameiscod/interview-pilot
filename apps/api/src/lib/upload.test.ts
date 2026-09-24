import { describe, expect, it } from 'vitest';
import { safeFileName } from './upload.js';

describe('safeFileName', () => {
  it.each([
    ['resume.pdf', 'resume.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\asha\\My CV.docx', 'My CV.docx'],
    ['bad\u0000name\u001f.pdf', 'badname.pdf'],
    ['   ', 'document'],
    ['folder/', 'document'],
  ])('%j -> %j', (input, expected) => expect(safeFileName(input)).toBe(expected));

  it('caps the length', () => {
    expect(safeFileName(`${'a'.repeat(300)}.pdf`)).toHaveLength(200);
  });
});
