import { API_V1_PREFIX, ApiErrorBody, CSRF_HEADER, type ErrorCode } from '@cbi/shared-types';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class ApiClientError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string,
    public readonly status: number | null,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Current access token, if signed in. */
  getAccessToken?: () => string | null;
  /**
   * Called once when an authenticated request gets 401. Returns a fresh access
   * token (the request is retried once) or null (the error propagates).
   */
  refreshAccessToken?: () => Promise<string | null>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Adds the CSRF header required by cookie-authenticated endpoints. */
  csrf?: boolean;
  /** Skip the refresh-and-retry behaviour (used by the auth endpoints themselves). */
  noRefresh?: boolean;
  signal?: AbortSignal;
}

/**
 * Fetch wrapper for `/api/v1`. Unwraps `{ data }`, converts `{ error }` into a
 * typed `ApiClientError`, attaches the access token, and transparently
 * refreshes an expired session once. Cookies are included so the httpOnly
 * refresh cookie reaches the auth endpoints.
 */
export function createApiClient(opts: ApiClientOptions) {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send<T>(path: string, options: RequestOptions, token: string | null): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${opts.baseUrl}${API_V1_PREFIX}${path}`, {
        method: options.method ?? 'GET',
        credentials: 'include',
        signal: options.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.csrf ? { [CSRF_HEADER]: '1' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new ApiClientError(
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
        null,
      );
    }

    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = ApiErrorBody.safeParse(payload);
      if (parsed.success) {
        const { code, message, requestId, details } = parsed.data.error;
        throw new ApiClientError(code, message, response.status, requestId, details);
      }
      throw new ApiClientError('INVALID_RESPONSE', 'Unexpected server response', response.status);
    }
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    throw new ApiClientError('INVALID_RESPONSE', 'Unexpected server response', response.status);
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = opts.getAccessToken?.() ?? null;
    try {
      return await send<T>(path, options, token);
    } catch (err) {
      const canRetry =
        err instanceof ApiClientError &&
        err.status === 401 &&
        token !== null &&
        !options.noRefresh &&
        opts.refreshAccessToken;
      if (!canRetry) throw err;
      const fresh = await opts.refreshAccessToken!();
      if (!fresh) throw err;
      return send<T>(path, options, fresh);
    }
  }

  return {
    request,
    get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
