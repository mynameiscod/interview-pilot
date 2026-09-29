import { mongoose } from '@cbi/db';
import { describe, expect, it } from 'vitest';
import { parseCandidateSearch } from '../admin/candidates.service.js';
import { exportable } from './privacy.service.js';
import { profileUpdate } from './users.routes.js';

describe('data export', () => {
  it('converts ids and dates and never includes secrets or storage locations', () => {
    const id = new mongoose.Types.ObjectId();
    const out = exportable({
      _id: id,
      primaryEmail: 'a@example.com',
      passwordHash: 'scrypt$...',
      mfa: { secret: { ciphertext: 'x' } },
      createdAt: new Date('2026-09-01T00:00:00Z'),
      nested: [{ storageKey: 'resumes/u/1.pdf', tokenHash: 'h', originalName: 'cv.pdf' }],
      __v: 3,
    });
    expect(out).toEqual({
      id: String(id),
      primaryEmail: 'a@example.com',
      createdAt: '2026-09-01T00:00:00.000Z',
      nested: [{ originalName: 'cv.pdf' }],
    });
  });
});

describe('profile updates', () => {
  it('leaves the product-updates choice alone when it is not sent', () => {
    const update = profileUpdate({ displayName: 'Asha', preferredInterviewLanguage: 'en' });
    expect(update.$set).not.toHaveProperty('productUpdatesOptIn');
    expect(update).not.toHaveProperty('$unset');
  });

  it('sets the choice when sent and clears optional fields sent as null', () => {
    const update = profileUpdate({
      displayName: 'Asha',
      preferredInterviewLanguage: 'en',
      productUpdatesOptIn: false,
      currentRole: null,
      experienceLevel: 'FRESHER',
    });
    expect(update.$set).toMatchObject({ productUpdatesOptIn: false, experienceLevel: 'FRESHER' });
    expect(update.$unset).toEqual({ currentRole: '' });
  });
});

describe('candidate search', () => {
  it('recognises ids, emails, mobile numbers and names', () => {
    expect(parseCandidateSearch('')).toEqual({ kind: 'all' });
    expect(parseCandidateSearch('64f0c0ffee0000000000abcd')).toEqual({
      kind: 'id',
      id: '64f0c0ffee0000000000abcd',
    });
    expect(parseCandidateSearch(' Asha@Example.com ')).toEqual({
      kind: 'email',
      value: 'asha@example.com',
    });
    expect(parseCandidateSearch('98765 43210')).toEqual({ kind: 'mobile', value: '+919876543210' });
    expect(parseCandidateSearch('+91 98765-43210')).toEqual({
      kind: 'mobile',
      value: '+919876543210',
    });
    expect(parseCandidateSearch('asha@')).toMatchObject({ kind: 'emailPrefix' });
    expect(parseCandidateSearch('Asha R')).toMatchObject({ kind: 'name' });
  });

  it('escapes regular-expression syntax in names', () => {
    const search = parseCandidateSearch('a.*(b');
    if (search.kind !== 'name') throw new Error('expected a name search');
    expect(search.pattern.test('xa.*(b')).toBe(false);
    expect(search.pattern.test('a.*(b rao')).toBe(true);
    expect(search.pattern.test('aXXb')).toBe(false);
  });
});
