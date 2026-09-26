import type {
  AdminMeResponse,
  AdminRole,
  IntegrationKind,
  IntegrationSummary,
  Permission,
} from '@cbi/shared-types';
import { permissionsFor } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, makeUser, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app/routes';
import { loadAdminUser } from '../../app/session';
import { initI18n } from '../../i18n';

const REASON = 'Reason (recorded in the audit log)';

function adminMe(roles: AdminRole[]): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)] as Permission[],
  };
}

async function renderAt(
  path: string,
  roles: AdminRole[],
  handlers: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles)),
    ...handlers,
  });
  const i18n = await initI18n();
  const manager = createSessionManager({
    baseUrl: 'http://api.test',
    audience: 'admin',
    fetchImpl: api.fetchImpl,
    locks: null,
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider manager={manager} loadUser={loadAdminUser}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { api, router };
}

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string, index = 0) =>
  api.calls.filter((c) => c.key === key)[index]!.body;
const countOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).length;

const PROVIDERS: Record<IntegrationKind, string[]> = {
  email: ['ses', 'smtp', 'disabled'],
  payments: ['razorpay', 'disabled'],
  storage: ['bunny', 'disabled'],
  sms: ['msg91', 'disabled'],
  judge: ['codebegun', 'judge0', 'disabled'],
};
const SECRETS: Record<IntegrationKind, string[]> = {
  email: ['sesAccessKeyId', 'sesSecretAccessKey', 'smtpPass'],
  payments: ['keySecret', 'webhookSecret'],
  storage: ['accessKey'],
  sms: ['authKey'],
  judge: ['hmacSecret', 'judge0AuthToken'],
};

function summary(
  kind: IntegrationKind,
  overrides: Partial<IntegrationSummary> = {},
): IntegrationSummary {
  return {
    kind,
    source: 'none',
    provider: 'disabled',
    ready: false,
    missing: [],
    settings: {},
    secrets: Object.fromEntries(SECRETS[kind].map((f) => [f, { set: false, last4: null }])),
    providers: PROVIDERS[kind],
    updatedAt: null,
    updatedBy: null,
    lastTest: null,
    ...overrides,
  };
}

const storage = (overrides: Partial<IntegrationSummary> = {}) =>
  summary('storage', {
    source: 'admin',
    provider: 'bunny',
    ready: true,
    settings: { zone: 'cbi-files', regionHost: 'sg.storage.bunnycdn.com' },
    secrets: { accessKey: { set: true, last4: '1234' } },
    updatedAt: '2026-09-20T10:00:00.000Z',
    updatedBy: 'admin-1',
    lastTest: {
      ok: true,
      message: 'Wrote, read and deleted a test file.',
      at: '2026-09-21T09:00:00.000Z',
    },
    ...overrides,
  });

function all(overrides: Partial<Record<IntegrationKind, IntegrationSummary>> = {}) {
  return [
    summary('email', {
      source: 'env',
      provider: 'ses',
      ready: false,
      missing: ['sesAccessKeyId'],
    }),
    summary('payments', {
      source: 'admin',
      provider: 'razorpay',
      ready: true,
      settings: { keyId: 'rzp_test_abc' },
      secrets: {
        keySecret: { set: true, last4: 'wxyz' },
        webhookSecret: { set: true, last4: '9876' },
      },
      updatedAt: '2026-09-22T10:00:00.000Z',
      updatedBy: 'admin-1',
    }),
    storage(),
    summary('sms'),
    summary('judge', { source: 'env', provider: 'codebegun', ready: true }),
  ].map((s) => overrides[s.kind] ?? s);
}

/** The saved summary a PUT returns: the body applied onto the current summary. */
function applied(current: IntegrationSummary, body: unknown): IntegrationSummary {
  const b = body as {
    provider: string;
    settings: Record<string, unknown>;
    secrets: Record<string, string | null>;
  };
  const secrets = { ...current.secrets };
  for (const [f, v] of Object.entries(b.secrets)) {
    secrets[f] = v === null ? { set: false, last4: null } : { set: true, last4: v.slice(-4) };
  }
  return {
    ...current,
    source: 'admin',
    provider: b.provider,
    settings: b.settings,
    secrets,
    updatedAt: new Date().toISOString(),
    updatedBy: 'admin-1',
    lastTest: null,
  };
}

describe('integrations access', () => {
  it('appears in the System navigation', async () => {
    await renderAt('/system/integrations', ['OPERATIONS_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
    });
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const system = within(nav).getByRole('list', { name: 'System' });
    expect(within(system).getByRole('link', { name: 'Integrations' })).toBeInTheDocument();
  });

  it('blocks admins without system.read', async () => {
    await renderAt('/system/integrations', ['FINANCE_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
  });

  it('is read-only for operations admins and never shows secret values', async () => {
    await renderAt('/system/integrations', ['OPERATIONS_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
    });
    const storageCard = await screen.findByRole('region', { name: 'File storage' });
    expect(screen.getByText(/encrypted when saved and are never shown again/)).toBeInTheDocument();
    expect(
      screen.getByText('You can view this page; only super admins can change it.'),
    ).toBeInTheDocument();

    expect(within(storageCard).getByText('Ready')).toBeInTheDocument();
    expect(within(storageCard).getByText('Set here')).toBeInTheDocument();
    expect(within(storageCard).getByText('Bunny Storage')).toBeInTheDocument();
    expect(within(storageCard).getByText('Passed')).toBeInTheDocument();
    expect(
      within(storageCard).getByText('Wrote, read and deleted a test file.'),
    ).toBeInTheDocument();
    expect(within(storageCard).getByText('cbi-files')).toBeInTheDocument();
    expect(within(storageCard).getByText('Saved (•••• 1234)')).toBeInTheDocument();

    const email = screen.getByRole('region', { name: 'Email' });
    expect(within(email).getByText('Not ready: missing SES access key ID')).toBeInTheDocument();
    expect(within(email).getByText('From server file')).toBeInTheDocument();
    expect(within(email).getByText('Not tested yet')).toBeInTheDocument();

    const sms = screen.getByRole('region', { name: 'SMS' });
    expect(within(sms).getByText('Turned off', { selector: '.badge' })).toBeInTheDocument();
    expect(within(sms).getByText('Not set up')).toBeInTheDocument();

    const payments = screen.getByRole('region', { name: 'Payments' });
    expect(
      within(payments).getByText(/\/api\/v1\/payments\/webhooks\/razorpay$/),
    ).toBeInTheDocument();
    for (const event of [
      'payment.captured',
      'order.paid',
      'payment.failed',
      'refund.processed',
      'refund.failed',
    ]) {
      expect(within(payments).getByText(event)).toBeInTheDocument();
    }

    const judge = screen.getByRole('region', { name: 'Code judge' });
    expect(
      within(judge).getByText('Without a judge, coding rounds record the code without running it.'),
    ).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Test/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Use server file/ })).not.toBeInTheDocument();
  });

  it('offers editing, testing and reset to super admins', async () => {
    await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
    });
    expect(await screen.findByRole('button', { name: 'Edit File storage' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Test File storage connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Use server file instead for File storage' }),
    ).toBeInTheDocument();
    // Nothing saved here for email: there is no admin configuration to remove.
    expect(
      screen.queryByRole('button', { name: 'Use server file instead for Email' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('You can view this page; only super admins can change it.'),
    ).not.toBeInTheDocument();
  });
});

describe('editing an integration', () => {
  it('keeps, replaces and clears the storage key with the right request body', async () => {
    let current = storage();
    const { api } = await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all({ storage: current })),
      'PUT /admin/integrations/storage': (body) => {
        current = applied(current, body);
        return ok(current);
      },
    });
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: 'File storage' });

    // Kept: the password field starts empty and nothing is sent for it.
    await user.click(within(card).getByRole('button', { name: 'Edit File storage' }));
    const key = within(card).getByLabelText('Access key');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', 'Saved (•••• 1234)');
    expect(
      within(card).getByText(/Changing the storage zone after candidates have uploaded files/),
    ).toBeInTheDocument();
    const zone = within(card).getByLabelText('Storage zone');
    expect(zone).toHaveValue('cbi-files');
    await user.clear(zone);
    await user.type(zone, 'cbi-files-2');
    await user.type(within(card).getByLabelText(REASON), 'New zone');
    await user.click(within(card).getByRole('button', { name: 'Save File storage' }));
    expect(
      await within(card).findByText('File storage saved. The change applies immediately.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/integrations/storage', 0)).toEqual({
      provider: 'bunny',
      settings: { zone: 'cbi-files-2', regionHost: 'sg.storage.bunnycdn.com' },
      secrets: {},
      reason: 'New zone',
    });

    // Replaced: the typed value is sent.
    await user.click(within(card).getByRole('button', { name: 'Edit File storage' }));
    await user.type(within(card).getByLabelText('Access key'), 'new-secret-5678');
    await user.type(within(card).getByLabelText(REASON), 'Rotated key');
    await user.click(within(card).getByRole('button', { name: 'Save File storage' }));
    await expect.poll(() => countOf(api, 'PUT /admin/integrations/storage')).toBe(2);
    expect(bodyOf(api, 'PUT /admin/integrations/storage', 1)).toEqual({
      provider: 'bunny',
      settings: { zone: 'cbi-files-2', regionHost: 'sg.storage.bunnycdn.com' },
      secrets: { accessKey: 'new-secret-5678' },
      reason: 'Rotated key',
    });
    expect(await within(card).findByText('Saved (•••• 5678)')).toBeInTheDocument();

    // Cleared: a required key cannot be cleared while Bunny is chosen; turned off, null is sent.
    await user.click(within(card).getByRole('button', { name: 'Edit File storage' }));
    await user.click(within(card).getByRole('button', { name: 'Clear Access key' }));
    expect(within(card).getByLabelText('Access key')).toBeDisabled();
    await user.type(within(card).getByLabelText(REASON), 'Stop using Bunny');
    await user.click(within(card).getByRole('button', { name: 'Save File storage' }));
    expect(
      within(card).getByText(
        'Required for Bunny Storage; enter a new value instead of clearing it.',
      ),
    ).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/integrations/storage')).toBe(2);
    await user.selectOptions(within(card).getByLabelText('Provider'), 'disabled');
    expect(within(card).queryByLabelText('Storage zone')).not.toBeInTheDocument();
    expect(within(card).getByLabelText('Access key')).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Save File storage' }));
    await expect.poll(() => countOf(api, 'PUT /admin/integrations/storage')).toBe(3);
    expect(bodyOf(api, 'PUT /admin/integrations/storage', 2)).toEqual({
      provider: 'disabled',
      settings: {},
      secrets: { accessKey: null },
      reason: 'Stop using Bunny',
    });
    expect(await within(card).findByText('Turned off', { selector: '.badge' })).toBeInTheDocument();
  });

  it('shows the fields for the chosen provider', async () => {
    await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
    });
    const user = userEvent.setup();
    const email = await screen.findByRole('region', { name: 'Email' });
    await user.click(within(email).getByRole('button', { name: 'Edit Email' }));
    const provider = within(email).getByLabelText('Provider');
    expect(provider).toHaveValue('ses');
    for (const label of [
      'From address',
      'SES region',
      'SES access key ID',
      'SES secret access key',
    ]) {
      expect(within(email).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(email).queryByLabelText('SMTP host')).not.toBeInTheDocument();
    expect(within(email).getByLabelText('SES access key ID')).toHaveAttribute(
      'placeholder',
      'Not set',
    );

    await user.selectOptions(provider, 'smtp');
    for (const label of [
      'From address',
      'SMTP host',
      'SMTP port',
      'SMTP user name',
      'SMTP password',
    ]) {
      expect(within(email).getByLabelText(label)).toBeInTheDocument();
    }
    expect(
      within(email).getByRole('switch', { name: 'Use a secure (TLS) connection' }),
    ).toBeInTheDocument();
    expect(within(email).queryByLabelText('SES region')).not.toBeInTheDocument();
    expect(within(email).queryByLabelText('SES access key ID')).not.toBeInTheDocument();

    await user.selectOptions(provider, 'disabled');
    expect(within(email).queryByLabelText('From address')).not.toBeInTheDocument();
    expect(within(email).queryByLabelText('SMTP password')).not.toBeInTheDocument();

    const judge = screen.getByRole('region', { name: 'Code judge' });
    await user.click(within(judge).getByRole('button', { name: 'Edit Code judge' }));
    expect(within(judge).queryByLabelText('Judge0 auth token')).not.toBeInTheDocument();
    await user.selectOptions(within(judge).getByLabelText('Provider'), 'judge0');
    expect(within(judge).getByLabelText('Judge0 auth token')).toBeInTheDocument();
  });

  it('validates required and malformed values before saving', async () => {
    const { api } = await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
      'PUT /admin/integrations/email': (body) =>
        ok(
          applied(
            all().find((s) => s.kind === 'email')!,
            body,
          ),
        ),
    });
    const user = userEvent.setup();
    const email = await screen.findByRole('region', { name: 'Email' });
    await user.click(within(email).getByRole('button', { name: 'Edit Email' }));
    await user.selectOptions(within(email).getByLabelText('Provider'), 'smtp');
    await user.type(within(email).getByLabelText('SMTP port'), 'abc');
    await user.click(within(email).getByRole('button', { name: 'Save Email' }));
    expect(within(email).getAllByText('Required for SMTP server.')).toHaveLength(2);
    expect(within(email).getByLabelText('From address')).toHaveAttribute('aria-invalid', 'true');
    expect(within(email).getByLabelText('SMTP host')).toHaveAttribute('aria-invalid', 'true');
    expect(within(email).getByText('Enter a port from 1 to 65535.')).toBeInTheDocument();
    expect(within(email).getByText('Enter a reason of 3–300 characters.')).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/integrations/email')).toBe(0);

    await user.type(
      within(email).getByLabelText('From address'),
      'CareerPilot Interview <no-reply@codebegun.com>',
    );
    await user.type(within(email).getByLabelText('SMTP host'), 'smtp.example.com');
    const port = within(email).getByLabelText('SMTP port');
    await user.clear(port);
    await user.type(port, '465');
    await user.click(within(email).getByRole('switch', { name: 'Use a secure (TLS) connection' }));
    await user.type(within(email).getByLabelText('SMTP password'), 'smtp-pass');
    await user.type(within(email).getByLabelText(REASON), 'Move to SMTP');
    await user.click(within(email).getByRole('button', { name: 'Save Email' }));
    await expect.poll(() => countOf(api, 'PUT /admin/integrations/email')).toBe(1);
    expect(bodyOf(api, 'PUT /admin/integrations/email')).toEqual({
      provider: 'smtp',
      settings: {
        from: 'CareerPilot Interview <no-reply@codebegun.com>',
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
      },
      secrets: { smtpPass: 'smtp-pass' },
      reason: 'Move to SMTP',
    });

    const judge = screen.getByRole('region', { name: 'Code judge' });
    await user.click(within(judge).getByRole('button', { name: 'Edit Code judge' }));
    await user.type(within(judge).getByLabelText('Judge URL'), 'ftp://judge.example.com');
    await user.type(within(judge).getByLabelText('Signing secret'), 'too-short');
    await user.type(within(judge).getByLabelText(REASON), 'Connect the judge');
    await user.click(within(judge).getByRole('button', { name: 'Save Code judge' }));
    expect(
      within(judge).getByText('Enter an http(s) URL, for example https://judge.example.com.'),
    ).toBeInTheDocument();
    expect(within(judge).getByText('Use at least 32 characters.')).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/integrations/judge')).toBe(0);
  });

  it('requires secrets that are not saved yet and shows server validation details', async () => {
    const { api } = await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
      'PUT /admin/integrations/sms': () =>
        fail(400, 'VALIDATION_FAILED', [
          { path: ['templateId'], message: 'Template id is not DLT-approved' },
        ]),
    });
    const user = userEvent.setup();
    const sms = await screen.findByRole('region', { name: 'SMS' });
    await user.click(within(sms).getByRole('button', { name: 'Edit SMS' }));
    await user.selectOptions(within(sms).getByLabelText('Provider'), 'msg91');
    await user.type(within(sms).getByLabelText('Template ID'), 'tpl-1');
    await user.type(within(sms).getByLabelText(REASON), 'Turn on SMS');
    await user.click(within(sms).getByRole('button', { name: 'Save SMS' }));
    expect(within(sms).getByText('Required for MSG91; nothing is saved yet.')).toBeInTheDocument();
    expect(countOf(api, 'PUT /admin/integrations/sms')).toBe(0);

    await user.type(within(sms).getByLabelText('Auth key'), 'msg91-auth-key');
    await user.click(within(sms).getByRole('button', { name: 'Save SMS' }));
    expect(await within(sms).findByText('Template id is not DLT-approved')).toBeInTheDocument();
    expect(bodyOf(api, 'PUT /admin/integrations/sms')).toEqual({
      provider: 'msg91',
      settings: { templateId: 'tpl-1' },
      secrets: { authKey: 'msg91-auth-key' },
      reason: 'Turn on SMS',
    });
  });
});

describe('testing and resetting', () => {
  it('asks for a recipient before testing email', async () => {
    const { api } = await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all()),
      'POST /admin/integrations/email/test': (body) =>
        ok({ ok: true, message: `Test email sent to ${(body as { to: string }).to}.` }),
      'POST /admin/integrations/storage/test': () =>
        ok({ ok: false, message: 'Bunny rejected the access key.' }),
    });
    const user = userEvent.setup();
    const email = await screen.findByRole('region', { name: 'Email' });
    await user.click(within(email).getByRole('button', { name: 'Test Email connection' }));
    await user.type(within(email).getByLabelText('Send a test email to'), 'not-an-email');
    await user.click(within(email).getByRole('button', { name: 'Send test email' }));
    expect(within(email).getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(countOf(api, 'POST /admin/integrations/email/test')).toBe(0);

    const to = within(email).getByLabelText('Send a test email to');
    await user.clear(to);
    await user.type(to, 'ops@codebegun.com');
    await user.click(within(email).getByRole('button', { name: 'Send test email' }));
    expect(
      await within(email).findByText('Connection works: Test email sent to ops@codebegun.com.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/integrations/email/test')).toEqual({
      to: 'ops@codebegun.com',
    });

    const storageCard = screen.getByRole('region', { name: 'File storage' });
    await user.click(
      within(storageCard).getByRole('button', { name: 'Test File storage connection' }),
    );
    expect(
      await within(storageCard).findByText('Test failed: Bunny rejected the access key.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/integrations/storage/test')).toEqual({});
  });

  it('switches back to the server file with a reason and confirmation', async () => {
    let payments = all().find((s) => s.kind === 'payments')!;
    const { api } = await renderAt('/system/integrations', ['SUPER_ADMIN'], {
      'GET /admin/integrations': () => ok(all({ payments })),
      'POST /admin/integrations/payments/reset': () => {
        payments = summary('payments', { source: 'env', provider: 'razorpay', ready: true });
        return ok(payments);
      },
    });
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: 'Payments' });
    await user.click(
      within(card).getByRole('button', { name: 'Use server file instead for Payments' }),
    );
    expect(
      within(card).getByText(/This removes the Payments settings saved here/),
    ).toBeInTheDocument();
    const confirm = within(card).getByRole('button', { name: 'Remove and use server file' });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText(REASON), 'Keys moved to the server file');
    await user.click(confirm);
    expect(await within(card).findByText('Payments now uses the server file.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/integrations/payments/reset')).toEqual({
      reason: 'Keys moved to the server file',
    });
    expect(await within(card).findByText('From server file')).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: 'Use server file instead for Payments' }),
    ).not.toBeInTheDocument();
  });
});
