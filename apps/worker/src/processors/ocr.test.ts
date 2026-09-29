import { AiUnavailableError, type OcrRequest } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import { extractDocumentText } from '@cbi/documents';
import { buildScannedPdf, SAMPLE_RESUME_LINES } from '@cbi/documents/testing';
import { DOCUMENT_MIME } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { createDocumentOcr, stripFence } from './ocr.js';

const logger = createLogger({ service: 'test', level: 'silent', version: 'test', env: 'test' });

const PROMPT = {
  id: 'p1',
  key: 'ocr.document',
  version: 3,
  locale: 'en',
  feature: 'ocr.document' as const,
  messages: [
    { role: 'system' as const, content: 'Transcribe.' },
    { role: 'user' as const, content: 'Transcribe the attached {{documentKind}}.' },
  ],
};

function fakeAi(recognize: (req: OcrRequest, ctx: unknown) => Promise<string>, prompt = PROMPT) {
  const calls: { req: OcrRequest; ctx: unknown }[] = [];
  const ai = {
    prompts: { getActive: async () => prompt, invalidate() {} },
    router: {
      recognize: async (req: OcrRequest, ctx: unknown) => {
        calls.push({ req, ctx });
        const text = await recognize(req, ctx);
        return { result: { text }, model: { modelId: 'claude-sonnet-5-5' } };
      },
    },
  } as unknown as Pick<AiRuntime, 'router' | 'prompts'>;
  return { ai, calls };
}

const limits = { maxPages: 5, maxBytes: 1024 * 1024 };
const ctx = { userId: 'u1', kind: 'resume' as const };

describe('document OCR', () => {
  it('renders the versioned prompt and reads a scanned resume through the router', async () => {
    const t = fakeAi(async () => `\`\`\`\n${SAMPLE_RESUME_LINES.join('\n')}\n\`\`\``);
    const ocr = createDocumentOcr({ ai: t.ai, logger }, limits);
    const scanned = buildScannedPdf(2);

    // The scanned-PDF fallback end to end: no text layer, so the extractor asks OCR.
    const result = await extractDocumentText(scanned, {
      ocr: (file, mime, info) => ocr(file, mime, info, ctx),
    });
    expect(result).toMatchObject({ ocrUsed: true, parser: 'ocr', pages: 2 });
    expect(result.text.startsWith('Priya Sharma')).toBe(true);

    const call = t.calls[0]!;
    expect(call.req).toMatchObject({ mimeType: DOCUMENT_MIME.PDF, pages: 2 });
    expect(Buffer.from(call.req.document).equals(scanned)).toBe(true);
    expect(call.req.messages.at(-1)!.content).toBe('Transcribe the attached resume.');
    expect(call.ctx).toEqual({ userId: 'u1', prompt: { key: 'ocr.document', version: 3 } });
  });

  it('never sends documents over the page or size limits', async () => {
    const t = fakeAi(async () => 'text');
    const ocr = createDocumentOcr({ ai: t.ai, logger }, limits);
    expect(await ocr(buildScannedPdf(6), DOCUMENT_MIME.PDF, { pages: 6 }, ctx)).toBeNull();
    const small = createDocumentOcr({ ai: t.ai, logger }, { maxPages: 5, maxBytes: 10 });
    expect(await small(buildScannedPdf(1), DOCUMENT_MIME.PDF, { pages: 1 }, ctx)).toBeNull();
    expect(await ocr(Buffer.from('plain'), DOCUMENT_MIME.TXT, { pages: null }, ctx)).toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  it('falls back (null) when no prompt is active or no model can serve', async () => {
    const noPrompt = fakeAi(async () => 'x', null as never);
    expect(
      await createDocumentOcr({ ai: noPrompt.ai, logger }, limits)(
        buildScannedPdf(1),
        DOCUMENT_MIME.PDF,
        { pages: 1 },
        ctx,
      ),
    ).toBeNull();
    const down = fakeAi(async () => {
      throw new AiUnavailableError('ocr.document', []);
    });
    const ocr = createDocumentOcr({ ai: down.ai, logger }, limits);
    expect(await ocr(buildScannedPdf(1), DOCUMENT_MIME.PDF, { pages: 1 }, ctx)).toBeNull();
    // And the extractor then fails the scan exactly as it did without OCR.
    const err = await extractDocumentText(buildScannedPdf(1), {
      ocr: (file, mime, info) => ocr(file, mime, info, ctx),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NO_TEXT' });
  });

  it('strips a Markdown fence around plain text', () => {
    expect(stripFence('```text\nHello\nWorld\n```')).toBe('Hello\nWorld');
    expect(stripFence('No fence')).toBe('No fence');
  });
});
