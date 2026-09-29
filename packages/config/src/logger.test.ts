import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { censorLogValue, REDACT_PATHS } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: censorLogValue } }, stream);
  return { logger, lines };
}

describe('logger redaction', () => {
  it('redacts credentials at top level and one level deep', () => {
    const { logger, lines } = capture();
    logger.info({ otp: '123456', user: { refreshToken: 'rt-abc', name: 'A' } }, 'login');
    const out = lines.join('');
    expect(out).not.toContain('123456');
    expect(out).not.toContain('rt-abc');
    expect(out).toContain('"name":"A"');
  });

  it('masks contact details and removes names', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        email: 'asha.rao@example.com',
        user: { primaryMobile: '+919876543210', displayName: 'Asha Rao' },
        otp: { destination: 'asha.rao@example.com' },
        job: { name: 'resume.extract' },
      },
      'sent',
    );
    const out = lines.join('');
    expect(out).not.toContain('asha.rao');
    expect(out).not.toContain('Asha Rao');
    expect(out).not.toContain('98765');
    expect(out).toContain('"email":"a***@example.com"');
    expect(out).toContain('"primaryMobile":"******3210"');
    expect(out).toContain('"displayName":"[REDACTED]"');
    // Ordinary `name` fields (jobs, providers) stay readable.
    expect(out).toContain('"name":"resume.extract"');
  });

  it('never echoes non-string personal values', () => {
    expect(censorLogValue({ nested: 'x' }, ['email'])).toBe('[REDACTED]');
    expect(censorLogValue('12', ['phone'])).toBe('[REDACTED]');
    expect(censorLogValue('nobody', ['email'])).toBe('[REDACTED]');
  });

  it('redacts authorization and cookie headers', () => {
    const { logger, lines } = capture();
    logger.info({ req: { headers: { authorization: 'Bearer xyz', cookie: 'cb_rt=zzz' } } });
    const out = lines.join('');
    expect(out).not.toContain('Bearer xyz');
    expect(out).not.toContain('cb_rt=zzz');
  });
});
