import { renderPrompt, untrusted, type PromptValue } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import { JobTargetModel, ResumeModel, type ExtractionRecord } from '@cbi/db';
import { cleanText, ExtractionError, extractDocumentText, type OcrHook } from '@cbi/documents';
import {
  extractReadableText,
  safeFetchText,
  SafeFetchError,
  UrlBlockedError,
  type SafeFetchOptions,
  type StorageProvider,
} from '@cbi/provider-adapters';
import {
  DOCUMENT_LIMITS,
  JdStructured,
  ResumeStructured,
  type AiFeature,
  type ExtractionErrorCode,
  type ExtractionWarning,
} from '@cbi/shared-types';
import type { z } from 'zod';

export interface DocumentProcessorDeps {
  storage: StorageProvider;
  ai: AiRuntime;
  logger: Logger;
  fetch: Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'> &
    Partial<Pick<SafeFetchOptions, 'resolve' | 'isAllowedAddress' | 'extraPorts'>>;
  ocr?: OcrHook;
}

/** How much input text is sent to structuring prompts (cost control). */
export const STRUCTURE_INPUT_CHARS = 24_000;

/** Thrown for failures that retrying cannot fix; the input is marked FAILED with the code. */
class InputFailure extends Error {
  constructor(public readonly code: ExtractionErrorCode) {
    super(`input failed (${code})`);
  }
}

type Structured<T> = { data: T | null; promptVersion: number | null };

/**
 * Runs a structuring prompt. Failure is not fatal: the raw text still feeds
 * the interview, so the input becomes READY with STRUCTURE_UNAVAILABLE.
 */
async function structure<T>(
  deps: DocumentProcessorDeps,
  feature: AiFeature,
  schema: z.ZodType<T>,
  values: Record<string, PromptValue>,
  userId: string,
): Promise<Structured<T>> {
  const prompt = await deps.ai.prompts.getActive(feature);
  if (!prompt) {
    deps.logger.warn({ feature }, 'no active prompt; skipping structuring');
    return { data: null, promptVersion: null };
  }
  try {
    const result = await deps.ai.router.run<T>(
      feature,
      {
        messages: renderPrompt(prompt, values),
        output: { name: feature.replace('.', '_'), schema },
      },
      { userId, prompt: { key: prompt.key, version: prompt.version } },
    );
    return { data: result.data, promptVersion: prompt.version };
  } catch (err) {
    deps.logger.warn({ err, feature }, 'structuring failed; continuing with raw text');
    return { data: null, promptVersion: prompt.version };
  }
}

function readyExtraction(
  prev: ExtractionRecord,
  text: string,
  parser: string,
  warnings: ExtractionWarning[],
  ocrUsed: boolean,
  structured: boolean,
): ExtractionRecord {
  return {
    ...prev,
    status: 'READY',
    errorCode: null,
    parser,
    ocrUsed,
    charCount: text.length,
    warnings: [
      ...new Set([...warnings, ...(structured ? [] : ['STRUCTURE_UNAVAILABLE' as const])]),
    ],
    completedAt: new Date(),
  };
}

const failedExtraction = (prev: ExtractionRecord, code: ExtractionErrorCode): ExtractionRecord => ({
  ...prev,
  status: 'FAILED',
  errorCode: code,
  completedAt: new Date(),
});

function toInputFailure(err: unknown): InputFailure | null {
  if (err instanceof InputFailure) return err;
  if (err instanceof ExtractionError) return new InputFailure(err.code);
  if (err instanceof UrlBlockedError) return new InputFailure('URL_BLOCKED');
  if (err instanceof SafeFetchError) {
    // Server errors and timeouts may be transient; let the job retry them first.
    if (err.reason === 'TIMEOUT' || err.reason === 'NETWORK') return null;
    if (err.reason === 'HTTP_STATUS' && (err.status ?? 0) >= 500) return null;
    return new InputFailure(err.reason === 'TOO_LARGE' ? 'TOO_LARGE' : 'FETCH_FAILED');
  }
  return null;
}

/** Marks the input FAILED on permanent errors, or on the job's final attempt. */
async function withFailureHandling(
  finalAttempt: boolean,
  work: () => Promise<void>,
  markFailed: (code: ExtractionErrorCode) => Promise<unknown>,
  onTransientFinal: ExtractionErrorCode,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    const failure = toInputFailure(err);
    if (failure) {
      await markFailed(failure.code);
      return;
    }
    if (finalAttempt) await markFailed(onTransientFinal);
    throw err;
  }
}

export async function processResumeExtract(
  deps: DocumentProcessorDeps,
  resumeId: string,
  finalAttempt: boolean,
): Promise<void> {
  const resume = await ResumeModel.findOneAndUpdate(
    { _id: resumeId, 'extraction.status': { $in: ['PENDING', 'PROCESSING'] } },
    { $set: { 'extraction.status': 'PROCESSING' }, $inc: { 'extraction.attempts': 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!resume) return; // deleted or already finished

  await withFailureHandling(
    finalAttempt,
    async () => {
      const file = await deps.storage.get(resume.storageKey);
      const extracted = await extractDocumentText(file, { ocr: deps.ocr });
      const structured = await structure(
        deps,
        'resume.structure',
        ResumeStructured,
        { resume: untrusted(extracted.text.slice(0, STRUCTURE_INPUT_CHARS)) },
        String(resume.userId),
      );
      await ResumeModel.updateOne(
        { _id: resume._id },
        {
          $set: {
            mime: extracted.mime,
            rawText: extracted.text,
            structured: structured.data,
            extraction: readyExtraction(
              resume.extraction,
              extracted.text,
              extracted.parser,
              extracted.warnings,
              extracted.ocrUsed,
              structured.data !== null,
            ),
          },
        },
      );
      deps.logger.info(
        { resumeId, parser: extracted.parser, chars: extracted.text.length },
        'resume extracted',
      );
    },
    (code) =>
      ResumeModel.updateOne(
        { _id: resume._id },
        { $set: { extraction: failedExtraction(resume.extraction, code) } },
      ),
    'INTERNAL',
  );
}

/** Text of a fetched job page (HTML is reduced to its readable content). */
async function fetchJobText(deps: DocumentProcessorDeps, url: string) {
  const res = await safeFetchText(url, deps.fetch);
  const text =
    res.contentType.split(';')[0]!.trim().toLowerCase() === 'text/plain'
      ? cleanText(res.text)
      : cleanText(extractReadableText(res.text).text);
  return { text, finalUrl: res.finalUrl };
}

export async function processJdExtract(
  deps: DocumentProcessorDeps,
  jobTargetId: string,
  finalAttempt: boolean,
): Promise<void> {
  const target = await JobTargetModel.findOneAndUpdate(
    { _id: jobTargetId, 'extraction.status': { $in: ['PENDING', 'PROCESSING'] } },
    { $set: { 'extraction.status': 'PROCESSING' }, $inc: { 'extraction.attempts': 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!target) return;

  await withFailureHandling(
    finalAttempt,
    async () => {
      let text: string;
      let parser: string;
      let warnings: ExtractionWarning[] = [];
      let ocrUsed = false;
      const $set: Record<string, unknown> = {};

      switch (target.source) {
        case 'PASTE':
          text = cleanText(target.rawText ?? '');
          parser = 'paste';
          break;
        case 'UPLOAD': {
          const extracted = await extractDocumentText(await deps.storage.get(target.storageKey!), {
            ocr: deps.ocr,
          });
          text = extracted.text;
          parser = extracted.parser;
          warnings = extracted.warnings;
          ocrUsed = extracted.ocrUsed;
          $set.mime = extracted.mime;
          break;
        }
        case 'URL': {
          const fetched = await fetchJobText(deps, target.url!);
          text = fetched.text;
          parser = 'readability';
          $set.finalUrl = fetched.finalUrl;
          break;
        }
        case 'ROLE_ONLY':
          text = '';
          parser = 'none';
          break;
      }

      if (target.source !== 'ROLE_ONLY' && text.length < DOCUMENT_LIMITS.minPasteChars) {
        throw new InputFailure(target.source === 'URL' ? 'NOT_READABLE' : 'NO_TEXT');
      }
      if (text.length > DOCUMENT_LIMITS.maxTextChars) {
        text = text.slice(0, DOCUMENT_LIMITS.maxTextChars);
        warnings = [...warnings, 'TEXT_TRUNCATED'];
      }

      const structured: Structured<JdStructured> =
        target.source === 'ROLE_ONLY'
          ? { data: null, promptVersion: null }
          : await structure(
              deps,
              'jd.structure',
              JdStructured,
              {
                jd: untrusted(text.slice(0, STRUCTURE_INPUT_CHARS)),
                companyName: untrusted(target.companyName ?? ''),
              },
              String(target.userId),
            );
      const extraction = readyExtraction(
        target.extraction,
        text,
        parser,
        warnings,
        ocrUsed,
        // Nothing to structure for a role-only target.
        target.source === 'ROLE_ONLY' || structured.data !== null,
      );
      await JobTargetModel.updateOne(
        { _id: target._id },
        {
          $set: {
            ...$set,
            rawText: text || null,
            structured: structured.data,
            extraction,
          },
        },
      );
      deps.logger.info(
        { jobTargetId, source: target.source, chars: text.length },
        'job target extracted',
      );
    },
    (code) =>
      JobTargetModel.updateOne(
        { _id: target._id },
        { $set: { extraction: failedExtraction(target.extraction, code) } },
      ),
    target.source === 'URL' ? 'FETCH_FAILED' : 'INTERNAL',
  );
}
