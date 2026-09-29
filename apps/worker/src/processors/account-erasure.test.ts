import { createLogger } from '@cbi/config';
import { erasureStorageKeys, tombstoneUpdate, type ErasureResult } from '@cbi/db';
import { describe, expect, it, vi } from 'vitest';
import { runAccountErasure } from './account-erasure.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const storage = { put: vi.fn(), delete: vi.fn() };
const result = (userId: string): ErasureResult => ({
  userId,
  storageObjects: 2,
  documents: { resumes: 1 },
});

describe('account erasure sweep', () => {
  it('erases every due account and audits each one', async () => {
    const audit = vi.fn(async () => undefined);
    const erase = vi.fn(async (id: unknown) => result(String(id)));
    const counts = await runAccountErasure({
      storage,
      logger,
      due: async () => ['u1', 'u2'],
      erase,
      audit,
    });
    expect(counts).toEqual({ erased: 2, errors: 0 });
    expect(erase).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('keeps going after one account fails and retries it next time', async () => {
    const audit = vi.fn(async () => undefined);
    const counts = await runAccountErasure({
      storage,
      logger,
      due: async () => ['bad', 'good'],
      erase: async (id) => {
        if (id === 'bad') throw new Error('storage down');
        return result(String(id));
      },
      audit,
    });
    expect(counts).toEqual({ erased: 1, errors: 1 });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('skips accounts that were restored (signed in) in the meantime', async () => {
    const audit = vi.fn(async () => undefined);
    const counts = await runAccountErasure({
      storage,
      logger,
      due: async () => ['u1'],
      erase: async () => null,
      audit,
    });
    expect(counts).toEqual({ erased: 0, errors: 0 });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('erasure helpers', () => {
  it('collects each stored input and report PDF once', () => {
    expect(
      erasureStorageKeys({
        resumes: [{ storageKey: 'resumes/u/1.pdf' }],
        jobTargets: [{ storageKey: null }, { storageKey: 'job-descriptions/u/2.docx' }],
        reports: [
          { pdf: { storageKey: 'reports/s/1.pdf' } },
          { pdf: { storageKey: 'reports/s/1.pdf' } },
          { pdf: null },
        ],
      }),
    ).toEqual(['resumes/u/1.pdf', 'job-descriptions/u/2.docx', 'reports/s/1.pdf']);
  });

  it('leaves a tombstone without contact details or credentials', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const update = tombstoneUpdate(now);
    expect(update.$set).toMatchObject({ status: 'DELETED', 'deletion.completedAt': now });
    for (const field of ['primaryEmail', 'primaryMobile', 'passwordHash', 'mfa']) {
      expect(update.$unset).toHaveProperty(field);
    }
    expect(update.$inc.tokenVersion).toBe(1);
  });
});
