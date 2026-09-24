import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from './api-client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createApiClient', () => {
  it('prefixes /api/v1, sends credentials and unwraps the data envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { data: { id: 'u1' } }));
    const client = createApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await expect(client.get('/users/me')).resolves.toEqual({ id: 'u1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/users/me');
    expect(init.credentials).toBe('include');
  });

  it('maps the error envelope to a typed ApiClientError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json(403, { error: { code: 'FORBIDDEN', message: 'No access', requestId: 'r-1' } }),
      );
    const client = createApiClient({ baseUrl: '', fetchImpl });
    const err = await client.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403, requestId: 'r-1' });
  });

  it('reports network failures distinctly', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ baseUrl: '', fetchImpl });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null });
  });

  it('rejects responses that do not follow the contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { id: 'no-envelope' }));
    const client = createApiClient({ baseUrl: '', fetchImpl });
    await expect(client.get('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('serializes JSON bodies on POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { data: null }));
    const client = createApiClient({ baseUrl: '', fetchImpl });
    await client.post('/feedback', { rating: 5 });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"rating":5}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends FormData as-is so the browser sets the multipart boundary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { data: { id: 'r1' } }));
    const client = createApiClient({ baseUrl: '', fetchImpl });
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'cv.txt');
    await client.post('/resumes', form);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.body).toBe(form);
    expect(init.headers['Content-Type']).toBeUndefined();
  });
});

describe('session refresh', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh');
    const client = createApiClient({
      baseUrl: '',
      fetchImpl,
      getAccessToken: () => 'stale',
      refreshAccessToken,
    });
    await expect(client.get('/users/me')).resolves.toEqual({ ok: true });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[1]![1].headers.Authorization).toBe('Bearer fresh');
  });

  it('propagates the 401 when refresh fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }));
    const client = createApiClient({
      baseUrl: '',
      fetchImpl,
      getAccessToken: () => 'stale',
      refreshAccessToken: vi.fn().mockResolvedValue(null),
    });
    await expect(client.get('/users/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sends the CSRF header only when asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: '', fetchImpl });
    await client.post('/auth/logout', undefined, { csrf: true });
    expect(fetchImpl.mock.calls[0]![1].headers['x-cb-csrf']).toBe('1');
    await client.post('/auth/otp/request', {});
    expect(fetchImpl.mock.calls[1]![1].headers['x-cb-csrf']).toBeUndefined();
  });
});
