/**
 * Only allows same-app relative paths as post-login destinations, so a crafted
 * `?next=` link cannot send someone to another site (open redirect).
 * Rejects absolute URLs, protocol-relative `//host` and the `/\host` variant
 * that some browsers treat as protocol-relative.
 */
export function safeNextPath(raw: string | null, fallback = '/app'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return fallback;
  }
  return raw;
}
