# Consent, recordings, integrity observations and retention (Phase 8)

This phase adds three things:

- **Video interviews:** the voice pipeline plus the candidate's camera.
- **Versioned consent:** texts that candidates accept or decline, with every decision kept.
- **Recordings and integrity observations:** optional recording of video interviews, and neutral notes of browser events. Both are deleted automatically when their retention period ends.

Where things live:

- Contracts: [`packages/shared-types/src/consent.ts`](../../packages/shared-types/src/consent.ts) and [`media.ts`](../../packages/shared-types/src/media.ts)
- Recording lifecycle (finalize, delete, sweep): [`packages/db/src/media.ts`](../../packages/db/src/media.ts)
- API: [`apps/api/src/modules/consent/`](../../apps/api/src/modules/consent/) and [`apps/api/src/modules/media/`](../../apps/api/src/modules/media/)
- Worker: [`apps/worker/src/processors/media-sweep.ts`](../../apps/worker/src/processors/media-sweep.ts)

## Consent

Consent texts live in `consentTexts`, as append-only versions per **type** and **locale**. Only the `active` flag can change, and each type and locale has one active version. There are three types:

| Type               | Asked when                                                 | Required                                          |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| `VOICE_PROCESSING` | Voice and video interviews                                 | Yes                                               |
| `RECORDING`        | Video interviews whose template allows recording           | Only when the template says `recording: REQUIRED` |
| `INTEGRITY`        | Any interview whose template has `tabSwitchTracking: true` | Yes                                               |

`GET /interviews/:id/consents` returns what the interview asks for. The texts are in the interview language and fall back to English. `POST /interviews/:id/consents` records decisions.

- Every decision is appended to `consents` with the text version, the locale, a hashed IP and the user agent. It is audited as `interview.consent`.
- The session keeps the latest decision per type.
- Declining optional recording runs the video interview without recording. Declining a required consent blocks the start in that mode.
- When an admin activates a new version of a text, earlier acceptances no longer count. Candidates are asked again before their next start.

Seeded texts are English version 1, written without legal claims. **They need legal review (DPDP Act 2023) and reviewed Hindi and Telugu versions before launch.** Admins add versions under **Consent texts**. Creating a version needs `consent.manage` (super admin only); reading needs `consent.read`.

The start gate works as follows. In voice and video interviews, the session stays `READY` while the device check and consents are recorded. `POST /start` then refuses with a specific message if anything is missing. In one transaction it walks the state machine to `ACTIVE` and fixes `session.recording.enabled`: video, recording allowed by the template, and the recording consent accepted.

## Recordings

```text
browser: MediaRecorder(camera + mic, timeslice 10 s) → chunk #i
  → POST /interviews/:id/media/segments/:i   (raw body, video/webm or video/mp4, ≤ 8 MB)
     API → storage  media/<user>/<session>/<asset>/seg-00012.webm   → mediaAssets.segments[]
browser at the end → POST /interviews/:id/media/finalize {segmentCount, durationMs}
worker every 15 min → closes recordings nobody finalized; deletes expired ones
```

**Uploads never affect the interview.** They are separate HTTP calls with their own limits, and no interview state depends on them. The resilience rules:

- The browser keeps segments it hasn't uploaded yet in IndexedDB, and retries with exponential backoff. The queue survives reloads and reconnects.
- A storage failure answers **503 `PROVIDER_UNAVAILABLE`**, which means "retry later". The interview carries on.
- Segments are **idempotent by index**:
  - the same bytes again return 200 with `duplicate: true`;
  - different bytes for a stored index return 409.
- Segments can arrive in any order. They are accepted until 30 minutes after the interview ends, so a queue can drain after the candidate finishes.
- **Finalize** compares the stored indexes with the browser's count, writes a manifest next to the segments, and marks the recording:
  - `COMPLETE` when all segments are present;
  - `PARTIAL` when some are missing (the missing indexes are listed);
  - `FAILED` when nothing was stored.
- A segment that arrives after finalize re-runs it, so a `PARTIAL` recording can become `COMPLETE`.
- When the browser never finalizes (closed tab or crash), the worker sweep finalizes the recording once no upload has arrived for 30 minutes and the session is no longer live.
- Only the first segment carries the container header, and it is checked against the declared type. Limits: 600 segments and 1 GB per recording.

**Playback.** The API issues a signed link valid for 5 minutes: `/api/v1/media/play/:id?exp&sig`, an HMAC under a key derived from the server secret. The link streams the stored segments in order. MediaRecorder output joined this way is one playable WebM or fragmented MP4 file, so no transcoding is needed. The link needs no auth header, so a `<video>` element can use it directly.

- Candidates can watch and delete their own recording.
- Admins with `media.read` can watch it. Every link issued to an admin is audited as `media.playback`.
- Seeking isn't supported (the stream doesn't support range requests yet), and a `PARTIAL` recording may stop playing at the first gap.

**Retention and deletion.**

- `retentionExpiresAt` is the creation time plus `MEDIA_RETENTION_DAYS_DEFAULT`, which defaults to 90 days.
- The worker sweep deletes expired recordings' objects and marks them `DELETED` with the reason "Retention period ended". A storage failure leaves the recording for the next run.
- Candidates can delete their recording at any time.
- Admins with `media.manage` can purge one, with a reason. The purge is audited before anything is deleted.
- The asset record stays, without storage keys, as evidence of the deletion.

## Integrity observations

When the template tracks them and the candidate accepted `INTEGRITY`, the room sends `integrity:event` over the socket. Event types:

- `TAB_HIDDEN` and `TAB_VISIBLE` (the value is the milliseconds away);
- `WINDOW_BLUR` and `WINDOW_FOCUS`;
- `FULLSCREEN_EXIT`;
- `PASTE` (the value is the number of characters; the text is never sent);
- `CAMERA_LOST` and `MICROPHONE_LOST`.

Limits:

- The server stores them only for a live session with the consent.
- It keeps at most 500 per interview, and accepts at most 5 per second per connection.
- It records its own receive time as authoritative.

They are **observations, never judgements**:

- They are not part of scoring. A test checks that the score is identical with and without them.
- The report and PDF show counts, approximate time away and a short timeline, with a note that most have ordinary explanations.
- Admins see the full timeline under the recording and interview. The wording is neutral, and no candidate is labelled.

## Configuration

| Variable                         | Where  | Default              |
| -------------------------------- | ------ | -------------------- |
| `MEDIA_RETENTION_DAYS_DEFAULT`   | API    | 90                   |
| `WORKER_MEDIA_SWEEP_INTERVAL_MS` | worker | 900000 (15 min)      |
| `STORAGE_PROVIDER` / `BUNNY_*`   | both   | local in development |

Recordings use the same private storage as documents: Bunny Storage in production, and a local directory in development.
