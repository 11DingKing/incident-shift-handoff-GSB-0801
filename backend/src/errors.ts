import type { ConflictBody } from './types.js';

/** Base class for errors that carry an HTTP status code. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(entity: string, id: string) {
    super(404, `${entity} ${id} not found`, {
      error: 'not_found',
      entity,
      id,
    });
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message, { error: 'validation_error', message });
  }
}

export class ConflictError extends HttpError {
  constructor(body: ConflictBody) {
    super(409, body.message, body);
  }
}

/** Raised when a caller tries to mutate a signed (immutable) handoff. */
export class ImmutableError extends HttpError {
  constructor(message: string) {
    super(409, message, { error: 'immutable', message });
  }
}
