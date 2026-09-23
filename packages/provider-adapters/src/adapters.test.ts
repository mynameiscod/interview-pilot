import { describe, expect, it, vi } from 'vitest';
import { createSesEmailProvider } from './email/ses.js';
import { createSmtpEmailProvider } from './email/smtp.js';
import { ProviderError } from './errors.js';
import { createDevMailboxSmsProvider } from './sms/dev-mailbox.js';
import { createMsg91OtpProvider } from './sms/msg91.js';

const message = { to: 'asha@example.com', subject: 'Code', text: 'Your code is 123456' };

describe('SES adapter', () => {
  it('sends a UTF-8 simple email and returns the message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'ses-1' });
    const provider = createSesEmailProvider({
      region: 'ap-south-1',
      from: 'CareerPilot <no-reply@codebegun.com>',
      client: { send } as never,
    });
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: 'ses-1' });
    const input = send.mock.calls[0]![0].input;
    expect(input.Destination.ToAddresses).toEqual(['asha@example.com']);
    expect(input.Content.Simple.Subject).toEqual({ Data: 'Code', Charset: 'UTF-8' });
  });

  it('wraps failures without leaking the message body', async () => {
    const err = Object.assign(new Error('Email address is not verified'), {
      name: 'MessageRejected',
    });
    const provider = createSesEmailProvider({
      region: 'ap-south-1',
      from: 'x@y.com',
      client: { send: vi.fn().mockRejectedValue(err) } as never,
    });
    const failure = await provider.send(message).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).retryable).toBe(false);
    expect((failure as Error).message).not.toContain('123456');
  });
});

describe('SMTP adapter', () => {
  it('passes the message to the transport', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<m1>' });
    const provider = createSmtpEmailProvider({
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'dev@localhost',
      transport: { sendMail },
    });
    await expect(provider.send(message)).resolves.toEqual({ providerMessageId: '<m1>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'dev@localhost' }));
  });
});

describe('MSG91 adapter', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts the OTP through the Flow API without the + prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { type: 'success', message: 'req-1' }));
    const provider = createMsg91OtpProvider({
      authKey: 'key',
      templateId: 'tmpl',
      otpVariable: 'otp',
      fetchImpl,
    });
    await provider.sendOtp({ to: '+919876543210', code: '123456', ttlMinutes: 5 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect(init.headers.authkey).toBe('key');
    expect(JSON.parse(init.body)).toEqual({
      template_id: 'tmpl',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', otp: '123456' }],
    });
  });

  it('raises a ProviderError on rejection', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json(400, { type: 'error', message: 'bad template' }));
    const provider = createMsg91OtpProvider({
      authKey: 'k',
      templateId: 't',
      otpVariable: 'otp',
      fetchImpl,
    });
    await expect(
      provider.sendOtp({ to: '+919876543210', code: '123456', ttlMinutes: 5 }),
    ).rejects.toMatchObject({ provider: 'msg91', retryable: false });
  });

  it('treats network errors as retryable', async () => {
    const provider = createMsg91OtpProvider({
      authKey: 'k',
      templateId: 't',
      otpVariable: 'otp',
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await expect(
      provider.sendOtp({ to: '+919876543210', code: '123456', ttlMinutes: 5 }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('dev mailbox SMS', () => {
  it('delivers into the dev mailbox with a clearly marked subject', async () => {
    const send = vi.fn().mockResolvedValue({});
    const provider = createDevMailboxSmsProvider({ name: 'smtp', send });
    await provider.sendOtp({ to: '+919876543210', code: '654321', ttlMinutes: 5 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'sms-919876543210@dev-sms.local',
        subject: '[DEV SMS] to +919876543210',
      }),
    );
  });
});
