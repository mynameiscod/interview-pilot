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
3. **Consent:** `POST /interviews/:id/voice-consent` accepts the voice processing notice. The notice is versioned (`VOICE_CONSENT_VERSION`), and acceptance is audited.
4. **Start:** the session stays `READY` while the check and consent are recorded, so the candidate can still switch to text. `POST /start` then walks the state machine through `DEVICE_CHECK → CONSENT_REQUIRED → READY_TO_START → ACTIVE` in one transaction. It refuses with a specific message if anything is missing.

## During the interview

**Questions.** When a question is asked in voice mode, the API starts synthesizing it straight away.

- The room fetches the audio from `GET /interviews/:id/questions/:questionId/audio` with its bearer token and plays it. The question text stays on screen as captions.
- Audio is cached in Redis for 2 hours, and concurrent requests share one synthesis. Replaying a question therefore costs nothing.

**Answers.**

1. The browser records the answer with MediaRecorder: WebM/Opus, Ogg/Opus or MP4. There is a maximum of 5 minutes per answer.
2. On **Done**, it uploads the recording to `POST /interviews/:id/voice/transcribe`. The API checks that:
   - this is the current, unanswered question and the interview is in voice mode;
   - the recording is at least 500 ms and at most 10 MB;
   - the container is audio, detected from the bytes. The declared type is ignored.
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

## Evaluation

Scoring is unchanged. It is based on the transcript text only: no voice-prosody features (design §33). Spoken answers are labelled "spoken, automatically transcribed" in the evidence-extraction input, so that transcription slips and filler words are not held against the candidate.

## Testing

- `packages/ai-core/src/router-speech.test.ts`: speech routing, fallback, metering and route status.
- `packages/provider-adapters/src/speech/speech.test.ts`: provider request formats, error mapping and the mocks.
- `apps/api/src/modules/voice/voice.integration.test.ts`: the mocked voice end-to-end test. It covers the device check and consent gate, spoken questions and caching, a spoken answer becoming the server transcript, and degrade-to-text for STT and TTS.
- **Mock speech (development/test only):**
  - The mock STT transcribes a clip made by `mockSpeech(text)` to `text`. `mockSpeechFailure()` simulates an outage. A real microphone recording gives a labelled placeholder.
  - The mock TTS plays a short chime followed by silence.
- A manual browser matrix (Chrome, Edge, Firefox and Safari, on desktop and mobile) is in [voice-browser-matrix.md](../product/voice-browser-matrix.md).
