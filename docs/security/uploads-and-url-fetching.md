# Uploads and job-description URL fetching

Resumes, JD files and JD links are attacker-controlled input. This page covers how Phase 3 handles them. The input pipeline itself is described in [inputs and role analysis](../architecture/inputs-and-role-analysis.md).

## File uploads

- **One file per request, capped before it is read in full.** `multer` limits: `UPLOAD_MAX_MB` (default 8 MB), 1 file, 10 fields, 12 parts. Over the limit gets `413`, and nothing is stored.
- **The type comes from the bytes.** The API accepts `%PDF-`, a zip whose central directory names `word/document.xml` (DOCX), or valid UTF-8 text without binary control bytes. The file name, extension and browser `Content-Type` are ignored. Anything else gets `415 UNSUPPORTED_MEDIA_TYPE`.
- **Server-generated storage keys.** `resumes/<userId>/<objectId>.<ext>`. `assertStorageKey` rejects anything that could escape the zone or folder (`..`, empty segments, unexpected characters). The local development adapter also checks the resolved path stays under its root.
- **Display-only file names.** The original name has its path and control characters removed, is capped at 200 characters and is never used to build a path. Non-ASCII names are decoded as UTF-8.
- **Private storage.** Bunny Storage zones are private. Candidates never get direct links to their uploads in Phase 3. Signed playback URLs arrive with media in Phase 8.
- **Deletion.** Deleting a resume removes the record and then the stored object. If the object delete fails, it is logged; the Phase 8 retention job will sweep orphans.

## Parsing in the worker

Parsing never runs in the API process. The `documents` queue has its own concurrency (`WORKER_DOCUMENT_CONCURRENCY`, default 2).

| Threat                        | Control                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zip bombs (DOCX)              | Every entry is inflated in a streaming pass that counts real output bytes (declared header sizes are not trusted) and stops past 25 MB with `TOO_LARGE`. Encrypted, Zip64 and archives with more than 5,000 entries are rejected |
| Huge or crafted PDFs          | 30-page cap, text extraction only (no rendering, `disableFontFace`), `stopAtErrors: false`                                                                                                                                       |
| Hangs                         | 30 s timeout per document                                                                                                                                                                                                        |
| Encrypted PDFs                | Reported as `ENCRYPTED`; the candidate is asked to remove the password                                                                                                                                                           |
| Runaway text                  | Output is cleaned (control characters removed) and capped at 200,000 characters                                                                                                                                                  |
| Prompt injection in documents | Text reaches prompts only through `untrusted()` `<data>` blocks with the data-only instruction; outputs are schema-validated                                                                                                     |

Parsing fixtures are generated in code (`@cbi/documents/testing`) so no binary files are committed and every fixture's contents are visible in review.

## Fetching job-description URLs (SSRF guard)

`safeFetchText` in `@cbi/provider-adapters` is the only way the platform fetches a user-supplied URL. It runs in the worker.

| Rule          | Detail                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schemes       | `http` and `https` only. The API also rejects other schemes and URLs with credentials when the candidate submits them                                                                                                                                                                            |
| Ports         | Default ports only; any explicit port is refused                                                                                                                                                                                                                                                 |
| Credentials   | `user:pass@` URLs are refused                                                                                                                                                                                                                                                                    |
| Addresses     | **Every** DNS answer must be public unicast. One private, loopback, link-local, CGNAT, multicast, reserved or unspecified answer blocks the request. IPv4-mapped IPv6 is unwrapped first. IP literals in any IPv4 notation are normalised and checked                                            |
| DNS rebinding | The connection is pinned to the address that was checked. A second DNS answer is never used                                                                                                                                                                                                      |
| Redirects     | Followed manually, at most 5, and every hop gets the full check again                                                                                                                                                                                                                            |
| Response      | `text/html`, `application/xhtml+xml` or `text/plain` only. The size is capped by `Content-Length` and again while streaming (`JD_FETCH_MAX_BYTES`, default 2 MB). The whole fetch has a time limit (`JD_FETCH_TIMEOUT_MS`, default 10 s). `Accept-Encoding: identity`, so no decompression bombs |
| Output        | HTML is reduced to readable text (scripts, styles and navigation are dropped). Nothing from the page is ever rendered as HTML                                                                                                                                                                    |
| Logging       | Hosts and reasons only. Page content is not logged                                                                                                                                                                                                                                               |

Blocked URLs fail the job target with `URL_BLOCKED`. Unreachable or unusable pages fail with `FETCH_FAILED` or `NOT_READABLE`, and the wizard offers to paste the text instead. `safe-fetch.test.ts` is the SSRF test suite: address classification, URL policy, mixed private/public answers, mapped IPv6, rebinding, per-hop redirect checks, loops, size, type, status and time limits.

## Rate limits and quotas

Per user, after authentication: uploads 20 per 10 minutes, JD URL submissions 10 per 10 minutes, analysis requests 15 per 10 minutes. These limiters fail closed if Redis is down. Stored resumes (20), unfinished interviews (10) and analysis attempts per interview (5) are also capped.

## Access control

Every resume, job target and interview query includes the token's `userId`. Another user's id reads exactly like a missing one (`404`), so ids cannot be probed. The worker loads inputs with the session's `userId` too, so a session can never use someone else's resume or JD. AI-generated blueprints carry the candidate's `userId` and are visible only to admins with `library.read`.
