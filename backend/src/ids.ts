import { randomUUID } from 'node:crypto';

/** Generates a stable, prefixed id, e.g. genId('ho') -> 'ho-3f2a...'. */
export function genId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
