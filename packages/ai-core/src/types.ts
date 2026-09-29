import type {
  AiCallOutcome,
  AiCapability,
  AiEffort,
  AiFeature,
  AiModelParams,
  AiProviderKey,
  Currency,
  PricingUnit,
} from '@cbi/shared-types';
import type { z } from 'zod';
import type { EncryptedSecret } from './secrets.js';

// ---- Requests and results ----------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Ask for JSON that must validate against `schema`. */
export interface StructuredOutput<T> {
  /** Short identifier sent to providers that name their schemas (OpenAI). */
  name: string;
  schema: z.ZodType<T>;
}

export interface LlmRequest<T = unknown> {
  messages: ChatMessage[];
  output?: StructuredOutput<T>;
  /** Lowers the model's configured maximum for this call; never raises it. */
  maxOutputTokens?: number;
  /**
   * Reasoning effort for this call. The router fills it from the route when
   * absent; adapters drop it for models without an effort control.
   */
  effort?: AiEffort | null;
}

/**
 * Billable quantities reported by the provider. `inputTokens` includes any
 * `cachedInputTokens`; `cachedInputTokens` is the subset read from a cache.
 */
export interface UsageUnits {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
  /** Wall-clock seconds of a session (realtime), audio seconds (STT/TTS). */
  durationSec?: number;
  audioSec?: number;
  characters?: number;
  images?: number;
}

export const ZERO_USAGE: UsageUnits = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  requests: 0,
});

export type FinishReason = 'stop' | 'length' | 'refusal' | 'other';

/** The provider model plus the runtime parameters an adapter needs. */
export interface ModelTarget {
  providerKey: AiProviderKey;
  /** The provider's model id, e.g. `claude-opus-5`. */
  modelId: string;
  params: AiModelParams;
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface LlmCallInput {
  model: ModelTarget;
  request: LlmRequest;
  credentials: ProviderCredentials;
  signal: AbortSignal;
}

export interface LlmCallResult {
  text: string;
  /** The model that actually produced the output (server-side fallbacks can differ). */
  servedModel: string | null;
  finishReason: FinishReason;
  usage: UsageUnits;
}

/**
 * One adapter per provider. Adapters translate requests, map provider errors
 * to `AiProviderError`, and never log prompts or outputs (they carry
 * candidate data). Retries, timeouts and fallback are the router's job:
 * adapters must disable SDK-level retries.
 */
export interface LlmAdapter {
  readonly providerKey: AiProviderKey;
  generate(input: LlmCallInput): Promise<LlmCallResult>;
  /**
   * Optional incremental output: text deltas as they arrive, then exactly one
   * `done` event carrying what `generate` would have returned. Adapters
   * without it are served through `generate` (one delta with the full text).
   */
  stream?(input: LlmCallInput): AsyncIterable<LlmStreamEvent>;
}

export type LlmStreamEvent =
  { type: 'delta'; text: string } | { type: 'done'; result: LlmCallResult };

// ---- Speech ------------------------------------------------------------------

export interface SttRequest {
  audio: Uint8Array;
  /** Container type, e.g. `audio/webm` (codec parameters stripped). */
  mimeType: string;
  /** BCP-47-ish hint (`en`, `hi`, `te`), or null to let the model detect it. */
  language: string | null;
  /** Length measured by the client; used for metering when the provider reports none. */
  durationSec: number | null;
}

export interface SttCallInput {
  model: ModelTarget;
  request: SttRequest;
  credentials: ProviderCredentials;
  signal: AbortSignal;
}

export interface SttCallResult {
  text: string;
  /** Language the model detected, when reported. */
  language: string | null;
  /** 0–1 when the provider reports it. */
  confidence: number | null;
  /** Audio length as billed by the provider, when reported. */
  durationSec: number | null;
  servedModel: string | null;
  /**
   * Word-level timestamps (seconds from the start of the recording) when the
   * provider returns them; used for delivery coaching (pace, long pauses).
   */
  words?: SttWord[] | null;
}

export interface SttWord {
  word: string;
  start: number;
  end: number;
}

/** Speech-to-text for a complete recording. Same rules as LLM adapters: no retries, no logging of content. */
export interface SttAdapter {
  readonly providerKey: AiProviderKey;
  transcribe(input: SttCallInput): Promise<SttCallResult>;
  /** Optional streaming recognition (realtime voice); see `SpeechStreamProvider`. */
  openStream?: SpeechStreamProvider['openStream'];
}

/** A live transcription session's audio format and turn-detection settings. */
export interface SttStreamRequest {
  encoding: 'linear16';
  sampleRate: number;
  /** `en`, `hi`, `te`, or null to let the model detect it. Adapters map it to their own codes. */
  language: string | null;
  /** Provider-side word-gap end of utterance (Deepgram `utterance_end_ms`). */
  utteranceEndMs: number;
}

export interface SttStreamInput {
  model: ModelTarget;
  request: SttStreamRequest;
  credentials: ProviderCredentials;
  /** Aborts the connection attempt and closes an open stream. */
  signal: AbortSignal;
  /** Everything the provider reports, in order. Never called after `closed`. */
  onEvent: (event: SpeechStreamEvent) => void;
}

export type SpeechStreamEvent =
  | {
      type: 'transcript';
      text: string;
      /** The words of this segment are settled (Deepgram `is_final`). */
      isFinal: boolean;
      /** The provider's own endpoint: the speaker paused (Deepgram `speech_final`). */
      speechFinal: boolean;
      confidence: number | null;
      /** Seconds from the start of the stream. */
      start: number;
      duration: number;
    }
  | { type: 'speech_started'; at: number }
  | { type: 'utterance_end'; lastWordEnd: number | null }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

/** An open streaming recognition session. */
export interface SpeechStream {
  /** One audio frame in the requested encoding. */
  send(audio: Uint8Array): void;
  /** Ask the provider to flush what it has heard (final results follow). */
  finalize(): void;
  /** Bytes accepted but not yet on the wire (backpressure). */
  bufferedAmount(): number;
  /** Ends the stream; resolves once the provider has closed it. */
  close(): Promise<{ durationSec: number | null; servedModel: string | null }>;
}

/**
 * Streaming speech-to-text (Deepgram live, the mock). `openStream` resolves
 * once the provider accepted the connection, or rejects with an
 * `AiProviderError` (the router then tries the next model).
 */
export interface SpeechStreamProvider {
  readonly providerKey: AiProviderKey;
  openStream(input: SttStreamInput): Promise<SpeechStream>;
}

export interface TtsRequest {
  text: string;
  language: string | null;
}

export interface TtsCallInput {
  model: ModelTarget;
  request: TtsRequest;
  credentials: ProviderCredentials;
  signal: AbortSignal;
}

export interface TtsCallResult {
  audio: Uint8Array;
  /** e.g. `audio/mpeg`, `audio/wav`. */
  mimeType: string;
  servedModel: string | null;
}

/** Text-to-speech for one short utterance (an interview question). */
export interface TtsAdapter {
  readonly providerKey: AiProviderKey;
  synthesize(input: TtsCallInput): Promise<TtsCallResult>;
  /**
   * Optional streaming synthesis: audio chunks as the provider produces
   * them (one container, `mimeType`). Adapters without it are served through
   * `synthesize` (one chunk).
   */
  synthesizeStream?(input: TtsCallInput): Promise<TtsStream>;
}

export interface TtsStream {
  mimeType: string;
  chunks: AsyncIterable<Uint8Array>;
}

export interface AdapterRegistry {
  llm(providerKey: AiProviderKey): LlmAdapter | undefined;
  stt?(providerKey: AiProviderKey): SttAdapter | undefined;
  tts?(providerKey: AiProviderKey): TtsAdapter | undefined;
}

// ---- Runtime configuration (loaded from MongoDB, cached in-process) ----------

export interface RuntimePrice {
  unit: PricingUnit;
  pricePerUnitMicros: number;
  currency: Currency;
  effectiveFrom: Date;
}

export interface RuntimeProvider {
  id: string;
  key: AiProviderKey;
  enabled: boolean;
  credential: EncryptedSecret | null;
  baseUrl: string | null;
}

export interface RuntimeModel {
  id: string;
  providerId: string;
  modelId: string;
  enabled: boolean;
  capabilities: AiCapability[];
  params: AiModelParams;
  pricing: RuntimePrice[];
}

export interface RuntimeRoute {
  feature: AiFeature;
  active: boolean;
  chain: { modelId: string; priority: number }[];
  /** Null or absent: the provider default. */
  effort?: AiEffort | null;
}

export interface AiRuntimeConfig {
  providers: Map<string, RuntimeProvider>;
  models: Map<string, RuntimeModel>;
  routes: Map<AiFeature, RuntimeRoute>;
  loadedAt: Date;
}

export interface AiConfigSource {
  get(): Promise<AiRuntimeConfig>;
  /** Drop the cached copy (called on the Redis pub/sub bust). */
  invalidate(): void;
}

// ---- Metering ----------------------------------------------------------------

export interface PriceSnapshot {
  currency: Currency;
  entries: RuntimePrice[];
}

export interface AiCallContext {
  correlationId?: string;
  sessionId?: string;
  userId?: string;
  /** The prompt template version used, when the call came from the registry. */
  prompt?: { key: string; version: number };
  /** Aborting (e.g. the candidate disconnected) stops the call without fallback. */
  signal?: AbortSignal;
}

export interface AiUsageRecord {
  at: Date;
  feature: AiFeature;
  providerKey: AiProviderKey;
  providerId: string;
  modelRef: string;
  model: string;
  servedModel: string | null;
  outcome: AiCallOutcome;
  errorCode: string | null;
  /** 1-based attempt number on this model (repair calls count as attempts). */
  attempt: number;
  latencyMs: number;
  units: UsageUnits;
  priceSnapshot: PriceSnapshot | null;
  costMicros: number;
  currency: Currency;
  context: Omit<AiCallContext, 'signal'>;
}

export interface UsageSink {
  record(record: AiUsageRecord): Promise<void>;
}

/**
 * Wraps a usage sink so `observe` (e.g. Prometheus latency/error metrics) sees
 * every metered call first. The observer runs synchronously and can never fail
 * the write or the call.
 */
export function withUsageObserver(
  sink: UsageSink,
  observe: (record: AiUsageRecord) => void,
): UsageSink {
  return {
    async record(record) {
      try {
        observe(record);
      } catch {
        // Metrics are best-effort; metering to the database is what matters.
      }
      await sink.record(record);
    },
  };
}

/** Minimal structured logger (pino-compatible). */
export interface AiLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
