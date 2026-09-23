import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
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

  it('redacts authorization and cookie headers', () => {
    const { logger, lines } = capture();
    logger.info({ req: { headers: { authorization: 'Bearer xyz', cookie: 'cb_rt=zzz' } } });
    const out = lines.join('');
    expect(out).not.toContain('Bearer xyz');
    expect(out).not.toContain('cb_rt=zzz');
  });
});
