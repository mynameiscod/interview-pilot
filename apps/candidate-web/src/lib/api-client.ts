import { API_V1_PREFIX, ApiErrorBody, type ErrorCode } from '@cbi/shared-types';

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
}

/**
 * Thin fetch wrapper for `/api/v1`. Unwraps the `{ data }` success envelope and
 * turns the `{ error }` envelope into a typed `ApiClientError`. Cookies are
 * included so the refresh-token cookie reaches the auth endpoints (Phase 1).
 */
export function createApiClient({ baseUrl, fetchImpl = fetch }: ApiClientOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${API_V1_PREFIX}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ApiClientError(
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
        null,
      );
    }

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

  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
