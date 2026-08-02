import type { ConflictField } from './types.js';

export class HttpError extends Error {
  statusCode: number;
  body: Record<string, unknown>;

  constructor(statusCode: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.statusCode = statusCode;
    this.body = { error: message, ...body };
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, fields: ConflictField[] = []) {
    super(409, message, { conflictFields: fields });
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string) {
    super(404, `${resource} not found`);
  }
}

export class ImmutableHandoffError extends HttpError {
  constructor(message = 'Handoff package is already acknowledged and immutable') {
    super(409, message);
  }
}
