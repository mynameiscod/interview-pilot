import type { ProofView, ShareLinkSummary } from '@cbi/shared-types';
import { AuthProvider, createSessionManager } from '@cbi/web-core';
import { fail, fakeApi, makeSession, ok } from '@cbi/web-core/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useFlag, useFlags } from '../../app/system-api';
import { makeReport } from '../../test/report-fixtures';
import { renderRoute } from '../../test/render';

const LOAD = { timeout: 15_000 };
const signedIn = { 'POST /auth/refresh': () => ok(makeSession()) };
const flagOn = { 'GET /flags': () => ok({ 'reports.publicProof': true }) };

function makeLink(overrides: Partial<ShareLinkSummary> = {}): ShareLinkSummary {
  return {
    id: 'sh1',
    sessionId: 'int1',
    reportRevision: 1,
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    revokedAt: null,
    views: 3,
    lastViewedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    tokenHint: 'AbCd',
    ...overrides,
  };
}

function makeProof(overrides: Partial<ProofView> = {}): ProofView {
  return {
    candidateName: 'Asha',
    roleTitle: 'Backend Developer',
    mode: 'TEXT',
    completedAt: '2026-09-20T10:00:00.000Z',
    overall: 64,
    band: 'READY_WITH_GAPS',
    confidence: 'MEDIUM',
    dimensions: [
      { name: 'SQL', score: 48, weight: 20 },
      { name: 'Node.js', score: 72, weight: 40 },
      { name: 'Testing', score: null, weight: 10 },
    ],
    reviewed: false,
    expiresAt: '2026-10-04T10:00:00.000Z',
    disclaimer: 'Practice feedback, not a hiring decision.',
    ...overrides,
  };
}

function reportApi(extra: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    ...signedIn,
    'GET /reports/int1': () => ok(makeReport()),
    'GET /feedback/int1': () => ok(null),
    ...extra,
  });
}

async function openReport(api = reportApi()) {
  const utils = await renderRoute('/app/reports/int1', { api });
  await screen.findByRole('heading', { level: 1, name: 'Backend Developer' }, LOAD);
  return utils;
}

const shareCalls = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((c) => c.key.includes('/shares'));

describe('feature flags', () => {
  function wrapper(api: ReturnType<typeof fakeApi>) {
    const manager = createSessionManager({
      baseUrl: 'http://api.test',
      audience: 'candidate',
      fetchImpl: api.fetchImpl,
      locks: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider manager={manager}>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }

  it('turns every flag off when the flags cannot be loaded', async () => {
    const api = fakeApi({ 'GET /flags': () => fail(500, 'INTERNAL') });
    const { result } = renderHook(
      () => ({ all: useFlags(), proof: useFlag('reports.publicProof') }),
      {
        wrapper: wrapper(api),
      },
    );
    await waitFor(() => expect(api.calls.some((c) => c.key === 'GET /flags')).toBe(true));
    expect(result.current).toEqual({ all: {}, proof: false });
  });

  it('reads the flags evaluated for the caller', async () => {
    const api = fakeApi({ ...signedIn, ...flagOn });
    const { result } = renderHook(() => useFlag('reports.publicProof'), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current).toBe(true));
    const call = api.calls.find((c) => c.key === 'GET /flags')!;
    expect(call.headers.Authorization).toBe('Bearer access-token');
  });
});

describe('share a proof (report page)', () => {
  it('is hidden, and makes no share calls, while the flag is off', async () => {
    const api = reportApi({ 'GET /flags': () => ok({ 'reports.publicProof': false }) });
    await openReport(api);
    await waitFor(() => expect(api.calls.some((c) => c.key === 'GET /flags')).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Share a proof' })).not.toBeInTheDocument();
    expect(shareCalls(api)).toHaveLength(0);
  });

  it('is hidden when the flags are unavailable', async () => {
    const api = reportApi();
    await openReport(api);
    await waitFor(() => expect(api.calls.some((c) => c.key === 'GET /flags')).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Share a proof' })).not.toBeInTheDocument();
    expect(shareCalls(api)).toHaveLength(0);
  });

  it('creates a link, shows it once to copy, lists links and revokes one', async () => {
    let links = [makeLink({ id: 'old', tokenHint: 'Zz99', views: 0, lastViewedAt: null })];
    const api = reportApi({
      ...flagOn,
      'GET /reports/int1/shares': () => ok(links),
      'POST /reports/int1/shares': () => {
        const link = makeLink({ id: 'sh1', tokenHint: 'AbCd', views: 0, lastViewedAt: null });
        links = [link, ...links];
        return { status: 201, body: { data: { link, path: '/proof/AbCdSecretToken' } } };
      },
      'DELETE /reports/shares/old': () =>
        ok({ ...links.find((l) => l.id === 'old')!, revokedAt: new Date().toISOString() }),
    });
    await openReport(api);
    const user = userEvent.setup();

    const panel = (await screen.findByRole('heading', { name: 'Share a proof' }, LOAD)).closest(
      'section',
    )!;
    const scope = within(panel);
    expect(
      scope.getByText(/overall score, readiness band, evidence confidence and skill scores/),
    ).toBeInTheDocument();
    expect(
      scope.getByText(/never shows your transcript, answers, evidence, recording or contact/),
    ).toBeInTheDocument();
    expect(
      scope.getByText(/Anyone with the link can open it until it expires/),
    ).toBeInTheDocument();
    expect(await scope.findByText('Link starting Zz99…')).toBeInTheDocument();

    await user.selectOptions(scope.getByLabelText('Link expires after'), '30 days');
    await user.click(scope.getByRole('button', { name: 'Create link' }));

    const url = `${window.location.origin}/proof/AbCdSecretToken`;
    const field = await scope.findByRole('textbox', { name: 'Proof link' });
    expect(field).toHaveValue(url);
    expect(
      scope.getByText(/Copy it now: for your security it will not be shown again/),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.key === 'POST /reports/int1/shares')!.body).toEqual({
      expiresInDays: 30,
    });

    await user.click(scope.getByRole('button', { name: 'Copy link' }));
    expect(await scope.findByText('Link copied.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(url);

    // The list is refreshed with the new link; the old one can be revoked.
    expect(await scope.findByText('Link starting AbCd…')).toBeInTheDocument();
    await user.click(scope.getByRole('button', { name: 'Revoke Link starting Zz99…' }));
    await waitFor(() =>
      expect(
        scope.queryByRole('button', { name: 'Revoke Link starting Zz99…' }),
      ).not.toBeInTheDocument(),
    );
    const oldRow = scope.getByText('Link starting Zz99…').closest('li')!;
    expect(within(oldRow).getByText('Revoked')).toBeInTheDocument();
    expect(api.calls.some((c) => c.key === 'DELETE /reports/shares/old')).toBe(true);
  });

  it('explains the limit when five links are already active', async () => {
    const api = reportApi({
      ...flagOn,
      'GET /reports/int1/shares': () => ok([]),
      'POST /reports/int1/shares': () => fail(409, 'CONFLICT'),
    });
    await openReport(api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Create link' }, LOAD));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You can have 5 active links for a report. Revoke one first.',
    );
    expect(screen.queryByRole('textbox', { name: 'Proof link' })).not.toBeInTheDocument();
  });
});

describe('public proof page', () => {
  it('shows the read-only summary without signing in', async () => {
    const api = fakeApi({ 'GET /proof/tok123': () => ok(makeProof({ reviewed: true })) });
    await renderRoute('/proof/tok123', { api });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Asha' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByText('Interview readiness proof')).toBeInTheDocument();
    expect(screen.getByText('Backend Developer')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'Overall readiness 64 out of 100: Interview-ready with gaps',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Evidence confidence: Medium')).toBeInTheDocument();

    const skills = screen.getByRole('region', { name: 'Skills' });
    expect(
      within(skills)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Node.js (Weight 40%)72/100',
      'SQL (Weight 20%)48/100',
      'Testing (Weight 10%)Not assessed',
    ]);
    expect(screen.getByText(/Reviewed by CodeBegun/)).toBeInTheDocument();
    expect(screen.getByText('Practice feedback, not a hiring decision.')).toBeInTheDocument();
    expect(screen.getByText(/This link expires on/)).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex',
    );
  });

  it('uses a neutral name and no review note when those are not set', async () => {
    const api = fakeApi({
      'GET /proof/tok123': () => ok(makeProof({ candidateName: null, overall: null })),
    });
    await renderRoute('/proof/tok123', { api });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A CodeBegun candidate' }, LOAD),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Overall readiness not scored: Interview-ready with gaps' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reviewed by CodeBegun/)).not.toBeInTheDocument();
  });

  it('says the link is not available when it expired, was revoked or never existed', async () => {
    const api = fakeApi({ 'GET /proof/gone': () => fail(404, 'NOT_FOUND') });
    await renderRoute('/proof/gone', { api });
    expect(
      await screen.findByRole('heading', { name: 'This proof link is not available' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByText(/It may have expired or been revoked/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.key === 'GET /proof/gone')).toHaveLength(1);
  });
});
