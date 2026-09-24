import type { AdminMeResponse, AdminRole, Permission } from '@cbi/shared-types';
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
import { config } from '../../config';
import { initI18n } from '../../i18n';
import { formatBytes, formatOffset } from './format';
import { consentText, integrityEvent, mediaAsset } from './test-fixtures';

const REASON = 'Reason (recorded in the audit log)';

function adminMe(roles: AdminRole[], without: Permission[] = []): AdminMeResponse {
  return {
    ...makeUser({ id: 'admin-1', email: 'root@codebegun.com', adminRoles: roles }),
    permissions: [...permissionsFor(roles)].filter((p) => !without.includes(p)) as Permission[],
  };
}

async function renderAt(
  path: string,
  roles: AdminRole[],
  handlers: Parameters<typeof fakeApi>[0] = {},
  without: Permission[] = [],
) {
  const api = fakeApi({
    'POST /admin/auth/refresh': () => ok(makeSession()),
    'GET /admin/me': () => ok(adminMe(roles, without)),
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

const bodyOf = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.find((c) => c.key === key)!.body;
const callsTo = (api: ReturnType<typeof fakeApi>, key: string) =>
  api.calls.filter((c) => c.key === key).length;

/** fakeApi keys ignore the query string, so list requests are checked by URL. */
const mediaQueries = (api: ReturnType<typeof fakeApi>) =>
  (api.fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls
    .map(([url]) => new URL(url))
    .filter((u) => u.pathname.endsWith('/admin/media'))
    .map((u) => Object.fromEntries(u.searchParams));

const detailHandlers = (asset = mediaAsset()) => ({
  'GET /admin/media/med1': () => ok(asset),
  'GET /admin/interviews/ses1/integrity': () => ok([]),
});

describe('privacy helpers', () => {
  it('formats timeline offsets and sizes', () => {
    expect(formatOffset(130)).toBe('00:02:10');
    expect(formatOffset(3725)).toBe('01:02:05');
    expect(formatBytes(52_428_800, 'en')).toBe('50 MB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
  });
});

describe('privacy navigation', () => {
  it('shows the Privacy & recordings group to operations admins', async () => {
    await renderAt('/', ['OPERATIONS_ADMIN']);
    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    const group = within(nav).getByRole('list', { name: 'Privacy & recordings' });
    expect(within(group).getByRole('link', { name: 'Recordings' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Consent texts' })).toBeInTheDocument();
  });

  it('shows content admins consent texts but not recordings', async () => {
    await renderAt('/recordings', ['CONTENT_ADMIN']);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this section' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).queryByRole('link', { name: 'Recordings' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Consent texts' })).toBeInTheDocument();
  });
});

describe('recordings', () => {
  it('lists recordings and filters by status, deletion and search', async () => {
    const { api, router } = await renderAt('/recordings', ['OPERATIONS_ADMIN'], {
      'GET /admin/media': () =>
        ok([
          mediaAsset({
            status: 'PARTIAL',
            segmentCount: 58,
            missingSegments: [12, 40],
          }),
          mediaAsset({
            id: 'med2',
            userEmail: null,
            interviewTitle: null,
            status: 'FAILED',
            segmentCount: 0,
            expectedSegments: null,
            bytes: 0,
            deletion: { status: 'DELETED', at: new Date().toISOString(), reason: 'Request' },
          }),
        ]),
    });
    const table = await screen.findByRole('table');
    const partial = within(table).getByRole('row', { name: /asha@example.com/ });
    expect(within(partial).getByText('Partial')).toBeInTheDocument();
    expect(within(partial).getByText('58 of 60')).toBeInTheDocument();
    expect(within(partial).getByText('50 MB')).toBeInTheDocument();
    expect(within(partial).getByText('Backend Engineer mock')).toBeInTheDocument();
    expect(within(partial).getByText('Stored')).toBeInTheDocument();
    const failed = within(table).getByRole('row', { name: /user-7/ });
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(failed).getByText('0 segments received')).toBeInTheDocument();
    expect(within(failed).getByText(/^Deleted /)).toBeInTheDocument();
    expect(mediaQueries(api)[0]).toEqual({ limit: '100' });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Status'), 'PARTIAL');
    await user.selectOptions(screen.getByLabelText('Deletion'), 'NONE');
    await user.type(screen.getByLabelText('Search'), ' ses1 ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await expect
      .poll(() => router.state.location.search)
      .toBe('?status=PARTIAL&deletion=NONE&q=ses1');
    await expect
      .poll(() => mediaQueries(api).at(-1))
      .toEqual({ limit: '100', status: 'PARTIAL', deletion: 'NONE', q: 'ses1' });

    await user.click(
      await screen.findByRole('link', { name: 'Open recording for asha@example.com' }),
    );
    await expect.poll(() => router.state.location.pathname).toBe('/recordings/med1');
  });

  it('shows missing segments for a partial recording', async () => {
    await renderAt(
      '/recordings/med1',
      ['OPERATIONS_ADMIN'],
      detailHandlers(
        mediaAsset({ status: 'PARTIAL', segmentCount: 58, missingSegments: [12, 40] }),
      ),
    );
    const missing = await screen.findByRole('list', { name: 'Missing segments' });
    expect(within(missing).getByText('#12')).toBeInTheDocument();
    expect(within(missing).getByText('#40')).toBeInTheDocument();
    expect(screen.getByText('58 of 60')).toBeInTheDocument();
  });

  it('requests a playback link and plays it from the API origin', async () => {
    const playback = {
      url: '/api/v1/media/play/med1?exp=1767000000&sig=abc',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      mimeType: 'video/webm',
    };
    const { api } = await renderAt('/recordings/med1', ['OPERATIONS_ADMIN'], {
      ...detailHandlers(),
      'POST /admin/media/med1/playback': () => ok(playback),
    });
    expect(await screen.findByText(/Viewing is logged/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    const video = await screen.findByLabelText('Interview recording');
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', `${config.apiUrl.replace(/\/+$/, '')}${playback.url}`);
    expect(callsTo(api, 'POST /admin/media/med1/playback')).toBe(1);

    // Reopening asks for a fresh link (the old one may have expired).
    await user.click(screen.getByRole('button', { name: 'Close player' }));
    expect(screen.queryByLabelText('Interview recording')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    await screen.findByLabelText('Interview recording');
    expect(callsTo(api, 'POST /admin/media/med1/playback')).toBe(2);
  });

  it('requires a reason and confirmation before deleting a recording', async () => {
    const deleted = mediaAsset({
      deletion: { status: 'DELETED', at: new Date().toISOString(), reason: 'Candidate request' },
    });
    const { api } = await renderAt('/recordings/med1', ['OPERATIONS_ADMIN'], {
      ...detailHandlers(),
      'POST /admin/media/med1/purge': () => ok(deleted),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete recording' }));
    expect(screen.getByText(/permanently deleted from storage now/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Delete permanently' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Candidate request');
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByLabelText(
        'I understand the video is permanently deleted and this cannot be undone.',
      ),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByText('The recording was deleted.')).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/media/med1/purge')).toEqual({ reason: 'Candidate request' });
    expect(screen.queryByRole('button', { name: 'Delete recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch' })).not.toBeInTheDocument();
    expect(
      screen.getByText('This recording was deleted and can no longer be watched.'),
    ).toBeInTheDocument();
  });

  it('shows the server message when the recording was already deleted', async () => {
    await renderAt('/recordings/med1', ['SUPER_ADMIN'], {
      ...detailHandlers(),
      'POST /admin/media/med1/purge': () => fail(409, 'CONFLICT'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete recording' }));
    await user.type(screen.getByLabelText(REASON), 'Candidate request');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('CONFLICT');
  });

  it('hides deletion from admins without media.manage', async () => {
    await renderAt('/recordings/med1', ['OPERATIONS_ADMIN'], detailHandlers(), ['media.manage']);
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete recording' })).not.toBeInTheDocument();
  });

  it('shows browser observations as a neutral timeline', async () => {
    await renderAt('/recordings/med1', ['OPERATIONS_ADMIN'], {
      ...detailHandlers(),
      'GET /admin/interviews/ses1/integrity': () =>
        ok([
          integrityEvent({ type: 'TAB_HIDDEN', offsetSec: 130 }),
          integrityEvent({ type: 'TAB_VISIBLE', offsetSec: 142, value: 12_000 }),
          integrityEvent({ type: 'PASTE', offsetSec: 305, value: 42 }),
          integrityEvent({ type: 'WINDOW_FOCUS', offsetSec: 400, value: 95_000 }),
          integrityEvent({ type: 'CAMERA_LOST', offsetSec: 3725 }),
        ]),
    });
    const timeline = await screen.findByRole('list', { name: 'Browser observations timeline' });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('00:02:10Switched to another tab');
    expect(items[1]).toHaveTextContent('Returned to the interview tab after 12 seconds');
    expect(items[2]).toHaveTextContent('00:05:05Pasted 42 characters');
    expect(items[3]).toHaveTextContent('Interview window focused again after 1 min 35 s');
    expect(items[4]).toHaveTextContent('01:02:05Camera stopped sending video');
    expect(
      screen.getByText(/Most have ordinary explanations.*They are not part of the score\./),
    ).toBeInTheDocument();
    const section = timeline.closest('section')!;
    expect(section.textContent).not.toMatch(/violation|suspicious|cheat|flag/i);
  });
});

describe('consent texts', () => {
  const texts = [
    consentText(),
    consentText({
      id: 'ct-rec-en-1',
      version: 1,
      active: false,
      title: 'Recording (draft)',
      reason: 'First draft',
    }),
    consentText({
      id: 'ct-voice-hi-1',
      type: 'VOICE_PROCESSING',
      locale: 'hi',
      version: 1,
      title: 'आवाज़ प्रोसेसिंग',
    }),
  ];

  it('groups versions by consent and language with the active one highlighted', async () => {
    await renderAt('/consent-texts', ['SUPER_ADMIN'], {
      'GET /admin/consent-texts': () => ok(texts),
    });
    expect(
      await screen.findByText(/Consent texts need legal review before launch/),
    ).toBeInTheDocument();
    const group = await screen.findByRole('region', { name: 'Recording · English' });
    expect(within(group).getByText('Current: v2 · Recording your interview')).toBeInTheDocument();
    const rows = within(group).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('table-success');
    expect(within(rows[0]!).getByText('Active')).toBeInTheDocument();
    expect(rows[1]).not.toHaveClass('table-success');
    expect(within(rows[1]!).getByText('Inactive')).toBeInTheDocument();

    const hindi = screen.getByRole('region', { name: 'Voice processing · Hindi' });
    expect(within(hindi).getByText('आवाज़ प्रोसेसिंग')).toBeInTheDocument();
    const telugu = screen.getByRole('region', { name: 'Recording · Telugu' });
    expect(within(telugu).getByText('No versions yet.')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'View Recording English v2' }));
    expect(screen.getByText(/keep the video for 90 days/)).toBeInTheDocument();
  });

  it('creates a new version prefilled from an existing one', async () => {
    const created = consentText({
      id: 'ct-rec-en-3',
      version: 3,
      active: false,
      title: 'Recording your interview (v3)',
    });
    const { api } = await renderAt('/consent-texts', ['SUPER_ADMIN'], {
      'GET /admin/consent-texts': () => ok(texts),
      'POST /admin/consent-texts': () => ({ status: 201, body: { data: created } }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'New version from Recording English v2' }),
    );
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('Recording your interview');
    expect(screen.getByLabelText('Text')).toHaveValue(consentText().body);
    expect(screen.queryByLabelText('Consent')).not.toBeInTheDocument();

    await user.clear(title);
    await user.type(title, 'Recording your interview (v3)');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(await screen.findByText('Enter a reason of 3–300 characters.')).toBeInTheDocument();
    expect(callsTo(api, 'POST /admin/consent-texts')).toBe(0);

    await user.type(screen.getAllByLabelText(REASON)[0]!, 'Legal review feedback');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(
      await screen.findByText(
        'Created Recording (English) v3 (inactive). Activate it to show it to candidates.',
      ),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/consent-texts')).toEqual({
      type: 'RECORDING',
      locale: 'en',
      title: 'Recording your interview (v3)',
      body: consentText().body,
      reason: 'Legal review feedback',
    });
  });

  it('validates a brand-new text with the shared schema', async () => {
    const { api } = await renderAt('/consent-texts', ['SUPER_ADMIN'], {
      'GET /admin/consent-texts': () => ok(texts),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New consent text' }));
    await user.selectOptions(screen.getByLabelText('Consent'), 'INTEGRITY');
    await user.selectOptions(screen.getByLabelText('Language'), 'te');
    await user.type(screen.getByLabelText('Title'), 'Hi');
    await user.type(screen.getByLabelText('Text'), 'Too short');
    await user.click(screen.getByRole('button', { name: 'Create version' }));
    expect(await screen.findByText('Enter a title of 3–120 characters.')).toBeInTheDocument();
    expect(screen.getByText('Enter a text of 20–8000 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(callsTo(api, 'POST /admin/consent-texts')).toBe(0);
  });

  it('requires a reason to activate and explains candidates must accept again', async () => {
    const { api } = await renderAt('/consent-texts', ['SUPER_ADMIN'], {
      'GET /admin/consent-texts': () => ok(texts),
      'POST /admin/consent-texts/ct-rec-en-1/activate': () => ok({ ...texts[1], active: true }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Activate Recording English v1' }));
    expect(
      screen.getByText(
        'Candidates who accepted an earlier version must accept this one before their next interview starts.',
      ),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Activate Recording English v1' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(REASON), 'Approved by legal');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(
      await screen.findByText('Recording (English) v1 is now the current text.'),
    ).toBeInTheDocument();
    expect(bodyOf(api, 'POST /admin/consent-texts/ct-rec-en-1/activate')).toEqual({
      reason: 'Approved by legal',
    });
  });

  it('lets content admins read texts without manage controls', async () => {
    await renderAt('/consent-texts', ['CONTENT_ADMIN'], {
      'GET /admin/consent-texts': () => ok(texts),
    });
    const group = await screen.findByRole('region', { name: 'Recording · English' });
    expect(
      within(group).getByRole('button', { name: 'View Recording English v2' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New consent text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^New version from/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Activate/ })).not.toBeInTheDocument();
  });
});
