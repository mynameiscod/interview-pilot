import {
  AiProviderError,
  type SpeechStream,
  type SpeechStreamEvent,
  type SpeechStreamProvider,
  type SttStreamInput,
} from '@cbi/ai-core';

/** The part of a WHATWG WebSocket the live client uses (Node 24's global one, or a test fake). */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

const OPEN = 1;
const CLOSED = 3;
/** Deepgram closes a stream that sends nothing for 10 s; keep it alive while the candidate is quiet. */
const KEEPALIVE_MS = 5_000;
/** After CloseStream, how long to wait for the final results and metadata. */
const CLOSE_WAIT_MS = 3_000;

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  timestamp?: number;
  last_word_end?: number;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
  model_info?: Record<string, { name?: string }>;
}

/**
 * Deepgram language parameter for an interview language. Hindi answers mix
 * in English, so they use nova-3's code-switching model (`multi`, which
 * covers Hindi and English). Telugu has a monolingual model only.
 */
export function deepgramLiveLanguage(language: string | null): {
  language: string;
  endpointingMs: number;
} {
  // Deepgram recommends 100 ms endpointing for code-switching.
  if (language === null || language === 'hi') return { language: 'multi', endpointingMs: 100 };
  return { language, endpointingMs: 300 };
}

/**
 * Deepgram live transcription (`wss://api.deepgram.com/v1/listen`): 16 kHz
 * PCM16 in, `Results` / `SpeechStarted` / `UtteranceEnd` out. Interim
 * results, VAD events and utterance-end detection are on; the API decides
 * the end of the answer from them (it does not trust `speech_final` alone).
 * The key goes in the WebSocket subprotocol (`token, <key>`), server-side
 * only. Transcripts are never logged.
 */
export function createDeepgramLiveAdapter(
  opts: { webSocket?: WebSocketFactory; keepAliveMs?: number } = {},
): SpeechStreamProvider {
  const open: WebSocketFactory =
    opts.webSocket ??
    ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
  const keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  return {
    providerKey: 'deepgram',
    openStream(input: SttStreamInput): Promise<SpeechStream> {
      const { model, request, credentials, signal, onEvent } = input;
      const base = (credentials.baseUrl ?? 'https://api.deepgram.com')
        .replace(/\/$/, '')
        .replace(/^http/, 'ws');
      const lang = deepgramLiveLanguage(request.language);
      const params = new URLSearchParams({
        model: model.modelId,
        encoding: request.encoding,
        sample_rate: String(request.sampleRate),
        channels: '1',
        language: lang.language,
        interim_results: 'true',
        vad_events: 'true',
        utterance_end_ms: String(Math.max(1000, request.utteranceEndMs)),
        endpointing: String(lang.endpointingMs),
        smart_format: 'true',
        punctuate: 'true',
      });
      return new Promise<SpeechStream>((resolve, reject) => {
        let ws: WebSocketLike;
        try {
          ws = open(`${base}/v1/listen?${params}`, ['token', credentials.apiKey]);
        } catch (err) {
          reject(
            new AiProviderError('deepgram', 'NETWORK_ERROR', 'connect', 'could not connect', {
              cause: err,
            }),
          );
          return;
        }
        ws.binaryType = 'arraybuffer';
        let opened = false;
        let done = false;
        let lastSend = Date.now();
        let metadataDuration: number | null = null;
        let servedModel: string | null = null;
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        let closeWaiter: (() => void) | null = null;
        const emit = (event: SpeechStreamEvent) => {
          if (!done) onEvent(event);
        };
        const control = (type: string) => {
          if (ws.readyState === OPEN) ws.send(JSON.stringify({ type }));
        };
        const finish = () => {
          if (done) return;
          clearInterval(keepAlive);
          emit({ type: 'closed' });
          done = true;
          closeWaiter?.();
        };
        const onAbort = () => {
          if (!opened) {
            reject(
              new AiProviderError(
                'deepgram',
                'TIMEOUT',
                'aborted',
                'connection aborted or timed out',
              ),
            );
          }
          try {
            ws.close(1000);
          } catch {
            // Already closing.
          }
          finish();
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });

        ws.addEventListener('open', () => {
          opened = true;
          keepAlive = setInterval(() => {
            if (Date.now() - lastSend >= keepAliveMs) control('KeepAlive');
          }, keepAliveMs);
          resolve({
            send(audio) {
              if (ws.readyState !== OPEN || done) return;
              lastSend = Date.now();
              ws.send(audio);
            },
            finalize: () => control('Finalize'),
            bufferedAmount: () => ws.bufferedAmount,
            close() {
              return new Promise((resolveClose) => {
                const settle = () => {
                  clearTimeout(timer);
                  signal.removeEventListener('abort', onAbort);
                  resolveClose({ durationSec: metadataDuration, servedModel });
                };
                const timer = setTimeout(() => {
                  try {
                    ws.close(1000);
                  } catch {
                    // Already closed.
                  }
                  finish();
                  settle();
                }, CLOSE_WAIT_MS);
                if (done || ws.readyState === CLOSED) {
                  finish();
                  return settle();
                }
                closeWaiter = settle;
                // Deepgram sends the last results and the metadata, then closes the socket.
                control('CloseStream');
              });
            },
          });
        });

        ws.addEventListener('message', (event: { data: unknown }) => {
          if (typeof event.data !== 'string') return;
          let msg: DeepgramMessage;
          try {
            msg = JSON.parse(event.data) as DeepgramMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case 'Results': {
              const best = msg.channel?.alternatives?.[0];
              emit({
                type: 'transcript',
                text: (best?.transcript ?? '').trim(),
                isFinal: msg.is_final === true,
                speechFinal: msg.speech_final === true,
                confidence: typeof best?.confidence === 'number' ? best.confidence : null,
                start: msg.start ?? 0,
                duration: msg.duration ?? 0,
              });
              break;
            }
            case 'SpeechStarted':
              emit({ type: 'speech_started', at: msg.timestamp ?? 0 });
              break;
            case 'UtteranceEnd':
              emit({ type: 'utterance_end', lastWordEnd: msg.last_word_end ?? null });
              break;
            case 'Metadata':
              if (typeof msg.duration === 'number') metadataDuration = msg.duration;
              servedModel = Object.values(msg.model_info ?? {})[0]?.name ?? servedModel;
              break;
          }
        });

        ws.addEventListener('error', () => {
          // The WebSocket API hides the reason (e.g. a 401 on upgrade); the close event follows.
          if (!opened) {
            reject(
              new AiProviderError('deepgram', 'NETWORK_ERROR', 'connect', 'connection refused'),
            );
            finish();
          }
        });

        ws.addEventListener('close', (event: { code?: number }) => {
          if (!opened) {
            reject(
              new AiProviderError('deepgram', 'NETWORK_ERROR', 'connect', 'connection closed'),
            );
          } else if (!closeWaiter && event.code !== 1000) {
            // Closed by Deepgram (or the network) while the candidate was speaking.
            emit({
              type: 'error',
              error: new AiProviderError(
                'deepgram',
                event.code === 1008 ? 'BAD_REQUEST' : 'PROVIDER_ERROR',
                `ws_${event.code ?? 0}`,
                'stream closed by the provider',
              ),
            });
          }
          finish();
        });
      });
    },
  };
}
