import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from './errors.js';

/**
 * Accepts exactly one file in the `file` field, held in memory (documents are
 * small and go straight to object storage). Size and part counts are capped
 * before the body is fully read.
 */
export function singleFileUpload(maxBytes: number): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    // Browsers send UTF-8 file names; the multipart default (latin1) garbles non-ASCII names.
    defParamCharset: 'utf8',
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
  }).single('file');
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) {
        if (!req.file) return next(AppError.validation('Attach a file in the "file" field.'));
        return next();
      }
      if (err instanceof multer.MulterError) {
        return next(
          err.code === 'LIMIT_FILE_SIZE'
            ? new AppError(
                413,
                'PAYLOAD_TOO_LARGE',
                `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB.`,
              )
            : AppError.validation('Upload one file in the "file" field.'),
        );
      }
      return next(new AppError(400, 'BAD_REQUEST', 'Malformed upload'));
    });
  };
}

/** A display-safe file name: no path, no control characters, bounded length. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (cleaned || 'document').slice(0, 200);
}
