import { fakeApi } from '@cbi/web-core/testing';

type Handlers = Parameters<typeof fakeApi>[0];

/**
 * `fakeApi` plus multipart support: a FormData body is recorded as a plain
 * object (files become `{ name }`) so upload handlers and assertions work.
 */
export function fakeApiWithUploads(handlers: Handlers = {}) {
  const api = fakeApi(handlers);
  const inner = api.fetchImpl;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (init.body instanceof FormData) {
      const fields: Record<string, unknown> = {};
      init.body.forEach((value, key) => {
        fields[key] = typeof value === 'string' ? value : { name: value.name };
      });
      return inner(url, { ...init, body: JSON.stringify(fields) });
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
  return { ...api, fetchImpl };
}
