# Voice interviews (Phase 7)

In a voice interview the candidate answers by speaking and hears each question read aloud. The pipeline is **cascaded** and controlled by the interview engine (decision D4):

```text
question (engine) → text-to-speech → candidate hears it
candidate speaks → recorded answer → speech-to-text → transcript = the answer → engine
```

The engine, the question ledger, the planner and the time budget are exactly the same as in a text interview. Voice only changes how questions are delivered and how answers arrive.

- Contracts: [`packages/shared-types/src/voice.ts`](../../packages/shared-types/src/voice.ts)
- Adapters (Deepgram, OpenAI, ElevenLabs, mock): [`packages/provider-adapters/src/speech/`](../../packages/provider-adapters/src/speech/)
- Routing and metering: `transcribe` / `synthesize` / `routeStatus` in [`packages/ai-core/src/router.ts`](../../packages/ai-core/src/router.ts)
- API: [`apps/api/src/modules/voice/`](../../apps/api/src/modules/voice/)

## Speech providers

Speech goes through the same AI router as the LLM features. It has fallback chains, per-model retries, circuit breakers, cross-replica concurrency slots and usage metering with a price snapshot.

| Feature    | Default chain                                                                   | Metered by    |
| ---------- | ------------------------------------------------------------------------------- | ------------- |
| `stt.live` | Deepgram `nova-3` → OpenAI `gpt-4o-mini-transcribe` (→ `mock-stt` in dev)       | audio seconds |
| `tts.live` | ElevenLabs `eleven_flash_v2_5` → OpenAI `gpt-4o-mini-tts` (→ `mock-tts` in dev) | characters    |

- Admins manage providers, keys, models, voice ids (`params.voice` on TTS models), prices and chains in the console. **Test** on a speech model synthesizes a phrase (TTS) or transcribes one second of silence (STT).
- The interview language (`hi`, `te`, `en`) is passed as a hint. `auto` lets the model detect the language. If a model rejects a language (HTTP 400), the router moves on to the next model in the chain.
- `GET /voice/health` reports each feature as `AVAILABLE` (first choice usable), `DEGRADED` (only fallbacks are usable, but voice still works) or `UNAVAILABLE`. It works from configuration and circuit state and makes no provider calls.

## Before the interview

1. **Setup:** the candidate chooses Voice. VOICE is in `AVAILABLE_INTERVIEW_MODES`, and the template must list it.
2. **Device check** (browser): support for MediaRecorder and the chosen audio format, microphone permission and input level, a speaker test tone, a network round trip, and speech service status. The results are posted to `POST /interviews/:id/device-check`. Microphone and recorder are required, and a FAIL on either blocks the start. The check is valid for 24 hours.
3. **Consent:** the candidate accepts the voice processing notice through the generic consent endpoints (`GET`/`POST /interviews/:id/consents`, Phase 8). The texts are versioned and every decision is recorded and audited. See [media-and-consent.md](media-and-consent.md).
4. **Start:** the session stays `READY` while the check and consent are recorded, so the candidate can still switch to text. `POST /start` then walks the state machine through `DEVICE_CHECK → CONSENT_REQUIRED → READY_TO_START → ACTIVE` in one transaction. It refuses with a specific message if anything is missing.

## During the interview

**Questions.** When a question is asked in voice mode, the API starts synthesizing it straight away.

- The room fetches the audio from `GET /interviews/:id/questions/:questionId/audio` with its bearer token and plays it. The question text stays on screen as captions.
- Audio is cached in Redis for 2 hours, and concurrent requests share one synthesis. Replaying a question therefore costs nothing.
- One synthesis per question **across API replicas**: the first replica to ask takes a short Redis lock (`cbi:voice:tts-lock:<question>`, 20 s, released by token) and synthesizes; the others poll the cache and read its result. If the holder fails (its lock goes without a result) or outlasts the lock, a waiter synthesizes itself. Within a process, concurrent requests share one promise. When Redis is down, each replica synthesizes on its own.

**Answers.**

1. The browser records the answer with MediaRecorder: WebM/Opus, Ogg/Opus or MP4. There is a maximum of 5 minutes per answer: the recorder stops itself there, once (the elapsed-time tick is cleared as soon as a stop begins, so a slow `onstop` cannot start a second finish).
2. On **Done**, it uploads the recording to `POST /interviews/:id/voice/transcribe`. The API checks that:
   - this is the current, unanswered question and the interview is in voice mode;
   - the recording is at least 500 ms and at most 10 MB;
   - the container is audio, detected from the bytes. The declared type is ignored.

   **Duration is measured on the server.** Speech usage and cost are billed by duration, and some models (OpenAI) report none, so the browser's `durationMs` is not trusted. `audio-duration.ts` reads the container: WebM (the declared Duration, or the last block's timestamp, since MediaRecorder writes none), Ogg (the last granule position, less Opus' pre-skip), MP4 (`mvhd`, or the sum of the fragments that Safari writes) and WAV. When it can't read the file (MP3, or a damaged file) it uses the browser's value, bounded by what the bytes can hold at 6 kbit/s (Opus' floor). Either way the result is capped at 5 minutes. A provider's own reported duration still wins.

3. The transcript comes back for review with a `lowConfidence` hint. It is also stored server-side for 1 hour.
4. **Submit** sends `answer:text` with the `voiceTranscriptId`. The **server's transcript becomes the answer**, whatever text the client sends.
5. The turn records `source: 'VOICE'` and the speech metadata: duration, language, confidence and model.

**Degrade to text.** When every model in the STT or TTS chain fails:

- the request answers **503 `SPEECH_UNAVAILABLE`**, and the room receives `interview:degraded` `{ kind, options }`;
- the candidate can retry, continue reading the questions (TTS), or **switch to typing** with `POST /interviews/:id/mode`;
- the state, clock, ledger and questions are untouched;
- the switch is recorded in `voice.modeHistory`, audited, and broadcast as `interview:mode`;
- an interview that was set up for voice can switch back.

## Privacy and security

- **Audio is not stored.** Recordings are held in memory for the transcription call and sent to the speech provider, and synthesized questions live in Redis for 2 hours. Recording retention and playback are part of Phase 8 (media).
- The consent notice says that audio goes to third-party speech providers and that the transcript is used for the report.
- Transcripts are bound to user, session and question. Every endpoint is scoped to the signed-in candidate, and another candidate's interview returns 404.
- The `voice` rate limit (150 per 10 minutes per user, fail-closed) covers transcriptions and question audio.
- Provider error bodies are never logged or returned, only the HTTP status. Adapters never log audio or text.

## Delivery metrics

Each transcribed answer also gets delivery metrics for coaching (`deliveryMetrics` in [`packages/shared-types/src/delivery.ts`](../../packages/shared-types/src/delivery.ts)), stored with the transcript and then on the answer (`answer.voice.delivery`). Only the metrics are kept, never the word timings.

- **Word timestamps** come from the speech model where it supports them: Deepgram's `words` (requested with `filler_words=true`, so "um" and "uh" stay in the transcript), and OpenAI `whisper-1` with `response_format=verbose_json` and `timestamp_granularities[]=word`. The gpt-4o transcribe models only return text, so answers they transcribe have no timestamps (and no pause count).
- **Pace** is words per minute over the speech (first to last word) when timestamps exist, otherwise over the recording length; answers under 5 words or 3 seconds have none.
- **Filler words** are counted from per-language lists (English always, plus Hindi or Telugu for answers in those languages): English um, uh, basically, actually, "you know" (not after "do"), "like" only when set off by punctuation, and "so" only at the start of a sentence or before a comma; Hindi matlab/मतलब and yaani/यानी, and haan/हाँ and woh/वो when set off by punctuation; Telugu ante/అంటే, and ala/అలా, aa/ఆ and adi/అది when set off by punctuation. **Hedging phrases** (I think, maybe, probably, kind of, शायद, ఏమో, …) are counted the same way. Every list and target is in that one module.
- **Long pauses** are silences of 2 s or more between words (timestamps only).

Delivery is coaching only: it never affects a score, and the report says so (pace and filler words vary with accent, language and speech differences). See [evaluation and reports](evaluation-and-reports.md#delivery-spoken-answers).

## Evaluation

Scoring is unchanged. It is based on the transcript text only: no voice-prosody features (design §33), and the delivery metrics above never reach the scoring steps. Spoken answers are labelled "spoken, automatically transcribed" in the evidence-extraction input, so that transcription slips and filler words are not held against the candidate.

## Testing

- `packages/ai-core/src/router-speech.test.ts`: speech routing, fallback, metering and route status.
- `packages/provider-adapters/src/speech/speech.test.ts`: provider request formats (including word timestamps), error mapping and the mocks.
- `packages/shared-types/src/delivery.test.ts`: filler, hedging, pace and pause rules in English, Hindi and Telugu, and the tips.
- `apps/api/src/modules/voice/audio-duration.test.ts`: container durations (WebM without Duration, Ogg Opus, fragmented MP4, WAV) and the bounded fallback.
- `apps/api/src/modules/voice/voice.test.ts`: the question-audio cache shared by replicas (one synthesis, a failed holder, an expired wait, Redis down).
- `apps/candidate-web/src/features/room/voice-hooks.test.ts`: the answer limit finishes the recording once, with fake timers.
- `apps/api/src/modules/voice/voice.integration.test.ts`: the mocked voice end-to-end test. It covers the device check and consent gate, spoken questions and caching, a spoken answer becoming the server transcript, and degrade-to-text for STT and TTS.
- `tests/e2e/specs/voice-interview.spec.ts` and `video-interview.spec.ts`: the flows in Chromium with fake capture devices (device check, consent, recording an answer, reviewing and submitting it; for video, recording starting and its first segment uploaded).
- **Mock speech (development/test only):**
  - The mock STT transcribes a clip made by `mockSpeech(text)` to `text`. `mockSpeechFailure()` simulates an outage. A real microphone recording gives a labelled placeholder.
  - The mock TTS plays a short chime followed by silence.
- A manual browser matrix (Chrome, Edge, Firefox and Safari, on desktop and mobile) is in [voice-browser-matrix.md](../product/voice-browser-matrix.md).
