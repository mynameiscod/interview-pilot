# Voice interviews: manual browser matrix

These checks are the manual half of the Phase 7 exit criteria; the automated half is the mocked voice end-to-end test. Run them before each release that touches voice.

Speech setup:

- **Mock speech** (`AI_MOCK_MODE=true`, no speech keys) covers every flow. Questions play as a chime and answers transcribe as a placeholder.
- **Real speech:** at least one run should use real Deepgram and ElevenLabs (or OpenAI) keys, to check audio quality and transcripts.

**Browsers:** Chrome, Edge and Firefox on Windows and macOS; Safari on macOS; Safari on iOS; Chrome on Android.

Record each result as pass, fail or not applicable, with the browser version and a note.

| #   | Check                                                                                                                                                                                                     | Chrome | Edge | Firefox | Safari macOS | Safari iOS | Chrome Android |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | ------- | ------------ | ---------- | -------------- |
| 1   | Setup: choose Voice, the explanation appears, save, and Continue opens the device check                                                                                                                   |        |      |         |              |            |                |
| 2   | Device check, first visit: the permission prompt appears; Allow, speak, and the meter reaches Passed. Silence for 10 s gives Needs attention. A muted mic in the OS is detected                           |        |      |         |              |            |                |
| 3   | Mic blocked: Failed, with guidance. Re-allow from the address bar and Test again passes without a reload. "Block permanently" in site settings                                                            |        |      |         |              |            |                |
| 4   | No mic (unplugged or disabled) shows the no-device message. A mic held by another app (Zoom/Teams) shows the in-use message                                                                               |        |      |         |              |            |                |
| 5   | The speaker tone plays; both Yes and No work. With a Bluetooth headset, the tone plays and the mic is picked up                                                                                           |        |      |         |              |            |                |
| 6   | Recording format: WebM/Ogg Opus on Chrome, Edge and Firefox, MP4 on Safari (check the posted device check). Transcription accepts each format                                                             |        |      |         |              |            |                |
| 7   | Consent, then "You are ready", then Start is enabled. After a reload of the start page, Start is still enabled                                                                                            |        |      |         |              |            |                |
| 8   | Room: the first question plays after Start. After a hard reload, "Play question" appears if autoplay is blocked. Repeat works                                                                             |        |      |         |              |            |                |
| 9   | Record, Done, check the transcript, Submit; the next question plays. Record again works. An answer left running stops by itself at 5:00                                                                   |        |      |         |              |            |                |
| 10  | Tab switch or screen lock while recording: no mic indicator is left on after Done, after switching to text, or after leaving the room                                                                     |        |      |         |              |            |                |
| 11  | Type instead, then Answer by voice, in both directions. With a second tab open, the mode stays in sync (`interview:mode`)                                                                                 |        |      |         |              |            |                |
| 12  | Speech outage (disable the STT route, then the TTS route): each shows its banner, and each Switch to typing path works                                                                                    |        |      |         |              |            |                |
| 13  | Network drop while reviewing a transcript: after reconnecting, the answer is submitted exactly once                                                                                                       |        |      |         |              |            |                |
| 14  | Keyboard only through the whole flow. A screen reader (NVDA with Chrome, VoiceOver with Safari) announces recording, the transcript and mode changes. Reduced motion stops the pulse and blink animations |        |      |         |              |            |                |

**Known behaviour:**

- Safari records MP4 (AAC), and the API accepts it.
- iOS may block autoplay until the candidate taps. The room then shows **Play question**.
- The room picks the recording format again when recording starts. It matches the device check on the same browser.
