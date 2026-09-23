import type { ErrorCode } from '@cbi/shared-types';

/** An error that is safe to expose to clients with the given status and code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(message = 'Resource not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static unauthenticated(message = 'Please sign in to continue') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }

  static validation(message: string, details?: unknown) {
    return new AppError(400, 'VALIDATION_FAILED', message, details);
  }

  static conflict(message: string) {
    return new AppError(409, 'CONFLICT', message);
  }
}
