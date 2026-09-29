# Consent, recordings, integrity observations and retention (Phase 8)

This phase adds three things:

- **Video interviews:** the voice pipeline plus the candidate's camera.
- **Versioned consent:** texts that candidates accept or decline, with every decision kept.
- **Recordings and integrity observations:** optional recording of video interviews, and neutral notes of browser events. Both are deleted automatically when their retention period ends.

Where things live:

- Contracts: [`packages/shared-types/src/consent.ts`](../../packages/shared-types/src/consent.ts) and [`media.ts`](../../packages/shared-types/src/media.ts)
- Recording lifecycle (finalize, delete, sweep): [`packages/db/src/media.ts`](../../packages/db/src/media.ts)
- API: [`apps/api/src/modules/consent/`](../../apps/api/src/modules/consent/) and [`apps/api/src/modules/media/`](../../apps/api/src/modules/media/)
- Worker: [`apps/worker/src/processors/media-sweep.ts`](../../apps/worker/src/processors/media-sweep.ts) and [`media-file.ts`](../../apps/worker/src/processors/media-file.ts) (the joined, seekable file)

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
browser: MediaRecorder #p (camera + mic, timeslice 10 s) → chunk #i
  → POST /interviews/:id/media/segments/:i?part=p   (raw body, video/webm or video/mp4, ≤ 8 MB)
     API → storage  media/<user>/<session>/<asset>/seg-00012.webm   → mediaAssets.segments[]
browser at the end → POST /interviews/:id/media/finalize {segmentCount, durationMs}
                     → playbackFile PENDING
worker every minute → ffmpeg joins the parts → media/<…>/<asset>/recording.webm → playbackFile READY
worker every 15 min → closes recordings nobody finalized; deletes expired ones; re-sweeps deleted keys
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
- Limits: 600 segments, 200 parts and 1 GB per recording.

**Parts.** Every MediaRecorder instance writes its own container, with a header in its first chunk. A reload, the camera being re-acquired, or recording being turned off and on again each start a new recorder, so each is a **part**. The browser numbers parts (persisted with the queue, so numbering continues after a reload) and sends the part with every segment. The server marks a segment that starts a container (`header`, checked against the declared type; segment 0 must have one). A part whose first segment never arrived can't be decoded and is skipped; gaps later in a part are kept (players skip the missing clusters). Records from before parts existed are read as one part with the header in segment 0.

**The joined file.** Finalize marks `playbackFile` `PENDING`. The worker (`WORKER_MEDIA_FILE_INTERVAL_MS`, every minute) claims one recording at a time with a lease, writes each part's segments to a temporary file and runs the system **ffmpeg** (concat demuxer):

1. `-c copy` first: fast and lossless.
2. When the parts don't line up (a different camera resolution or codec), a re-encode: VP8/Opus for WebM, H.264/AAC for MP4.

MP4 gets `-movflags +faststart` (the index up front); the WebM muxer writes duration and cues. Either way the result is seekable. It's stored as `recording.webm` or `recording.mp4` next to the segments and marked `READY`.

- A failed build is retried (3 attempts), then marked `FAILED`. The parts keep playing.
- ffmpeg is installed in the worker image (`infrastructure/docker/node-service.Dockerfile`). Where it's missing (`MEDIA_FFMPEG_PATH` not found), the build is marked `UNAVAILABLE` and the recording plays part by part; a run stops after the first such recording.
- A late segment re-finalizes the recording and sets `PENDING` again. A build that was running then can't mark it `READY` (the claim time must still match), and the next run rebuilds.
- The output file is read into memory once for the upload (`StorageProvider.put` takes a buffer); segments are appended to disk one by one.

**Playback.** `GET /interviews/:id/media/playback-url` returns signed links valid for **30 minutes**: `/api/v1/media/play/:id?exp&sig` for the joined file (`source: FILE`), or one link per part with `&part=n` (`source: PARTS`) until the file is ready. Each link is an HMAC over the asset, the target (`file` or `part-n`) and the expiry, under a key derived from the server secret. The links need no auth header, so a `<video>` element can use them directly.

- **Byte ranges.** The stream answers a single `Range: bytes=…` with `206` and `Content-Range`, and a range past the end with `416`; every response has `Accept-Ranges: bytes`, so players can seek. Several ranges in one request are answered with the whole object (HTTP allows it). Storage is read window by window (4 MB) through the adapter's range read: Bunny Storage (`Range` header) and local storage support it; an adapter without it falls back to a whole read.
- **Failures.** A storage failure before anything is sent answers `503`. After the headers are out the response is destroyed (the player sees a broken transfer, never a short "complete" file) and the failure is logged.
- **Expiry.** When a link fails mid-watch (it expired, or the file replaced the parts) the candidate's player asks for new links once and continues from the same moment; a second failure within 10 seconds shows a message instead of looping.
- **Parts in the player.** While playing parts, the candidate sees "Part n of m" with previous and next buttons, and the next part starts when one ends.
- Candidates can watch and delete their own recording.
- Admins with `media.read` can watch it. Every link issued to an admin is audited as `media.playback`. The admin player uses `url` (the file, or the first part).
- Switching to text ends the recording for good.

**Retention and deletion.**

- `retentionExpiresAt` is the creation time plus `MEDIA_RETENTION_DAYS_DEFAULT`, which defaults to 90 days.
- The worker sweep deletes expired recordings' objects and marks them `DELETED` with the reason "Retention period ended".
- Candidates can delete their recording at any time.
- Admins with `media.manage` can purge one, with a reason. The purge is audited before anything is deleted.
- The asset record stays, without segments, as evidence of the deletion.

A delete runs in this order, so no object is left unreferenced:

1. Mark the asset `DELETING`. From then on segment uploads are refused: a segment is only attached to an asset whose deletion status is `NONE`. An upload whose object was stored just before is refused at the attach step, deletes its own object, and, if that fails, records the key on the asset.
2. Read the keys (segments, manifest, joined file) and delete them.
3. Mark it `DELETED`, keeping the deleted keys and a `sweepAfter` time (30 minutes later).

- The sweep deletes those keys **once more** after `sweepAfter`. That catches an object written by an upload or a file build that was already in flight when the delete began.
- A storage failure leaves the asset `DELETING`: not playable, no uploads. The sweep resumes it after 5 minutes.
- To candidates and admins, `DELETING` already reads as deleted.

## Integrity observations

When the template tracks them and the candidate accepted `INTEGRITY`, the room sends `integrity:event` over the socket. Event types:

- `TAB_HIDDEN` and `TAB_VISIBLE` (the value is the milliseconds away);
- `WINDOW_BLUR` and `WINDOW_FOCUS`;
- `FULLSCREEN_EXIT`;
- `PASTE` (the value is the number of characters; the text is never sent);
- `CAMERA_LOST` and `MICROPHONE_LOST`.

Limits:

- The server stores them only for a live session with the consent.
- It keeps at most 500 per interview, and accepts at most 5 per second per connection. The cap is a counter on the session (`integrityEventCount`), reserved with one conditional `$inc` per event, so storing an event never counts the collection.
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
| `WORKER_MEDIA_FILE_INTERVAL_MS`  | worker | 60000 (1 min)        |
| `MEDIA_FFMPEG_PATH`              | worker | `ffmpeg`             |
| `MEDIA_FFMPEG_TIMEOUT_MS`        | worker | 1200000 (20 min)     |
| `STORAGE_PROVIDER` / `BUNNY_*`   | both   | local in development |

Recordings use the same private storage as documents: Bunny Storage in production, and a local directory in development.
