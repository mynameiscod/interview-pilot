import { renderPrompt } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import type { Logger } from '@cbi/config';
import { DOCUMENT_MIME, type DocumentMime } from '@cbi/shared-types';

export interface OcrLimits {
  /** Scanned PDFs with more pages are not sent (they fail with NO_TEXT as before). */
  maxPages: number;
  maxBytes: number;
}

export interface OcrContext {
  userId: string;
  kind: 'resume' | 'job description';
}

/**
 * OCR for one document: `(file, mime, info) => text | null`. Null means "no
 * OCR" (over the limits, no prompt, no route or every model failed); the
 * extractor then fails the document with NO_TEXT and the OCR_NEEDED warning.
 */
export type DocumentOcr = (
  file: Buffer,
  mime: DocumentMime,
  info: { pages: number | null },
  ctx: OcrContext,
) => Promise<string | null>;

/** Upper bound on the transcript length we ask for (a few dense pages). */
const OCR_OUTPUT_TOKENS = 16_000;

/** Drops a Markdown fence some models wrap plain text in. */
export const stripFence = (text: string) =>
  text.replace(/^\s*```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i, '$1').trim();

/**
 * Scanned documents go to a document-capable model through the `ocr.document`
 * route (metered like any AI call). The whole file is sent: images cannot be
 * masked, which the privacy notice discloses. The recognised text is then
 * masked like any other text before structuring.
 */
export function createDocumentOcr(
  deps: { ai: Pick<AiRuntime, 'router' | 'prompts'>; logger: Logger },
  limits: OcrLimits,
): DocumentOcr {
  return async (file, mime, info, ctx) => {
    if (mime !== DOCUMENT_MIME.PDF) return null;
    if (file.length > limits.maxBytes || (info.pages ?? 0) > limits.maxPages) {
      deps.logger.info(
        { metric: 'ocr.skipped', reason: 'limits', pages: info.pages, bytes: file.length },
        'scanned document over the OCR limits',
      );
      return null;
    }
    const prompt = await deps.ai.prompts.getActive('ocr.document');
    if (!prompt) {
      deps.logger.warn('no active ocr.document prompt; skipping OCR');
      return null;
    }
    try {
      const result = await deps.ai.router.recognize(
        {
          document: new Uint8Array(file),
          mimeType: DOCUMENT_MIME.PDF,
          pages: info.pages,
          messages: renderPrompt(prompt, { documentKind: ctx.kind }),
          maxOutputTokens: OCR_OUTPUT_TOKENS,
        },
        { userId: ctx.userId, prompt: { key: prompt.key, version: prompt.version } },
      );
      deps.logger.info(
        { metric: 'ocr.used', pages: info.pages, model: result.model.modelId },
        'scanned document recognised',
      );
      return stripFence(result.result.text);
    } catch (err) {
      deps.logger.warn({ err }, 'OCR unavailable; the document stays unreadable');
      return null;
    }
  };
}
