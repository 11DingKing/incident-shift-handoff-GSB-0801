import type { PoolClient } from "pg";
import { getIdempotency, storeIdempotency } from "../repositories/auditRepo.js";

export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

export async function withIdempotency<T>(
  client: PoolClient,
  key: string | undefined,
  scope: string,
  fn: () => Promise<T>
): Promise<IdempotentResult<T>> {
  if (!key) {
    const result = await fn();
    return { result, replayed: false };
  }
  const existing = await getIdempotency(client, key);
  if (existing && existing.scope === scope) {
    return { result: existing.response as T, replayed: true };
  }
  const result = await fn();
  await storeIdempotency(client, key, scope, result as Record<string, unknown>);
  return { result, replayed: false };
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

export function isImmutableViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23514" &&
    "message" in err &&
    typeof (err as { message: string }).message === "string" &&
    (err as { message: string }).message.includes("immutable")
  );
}
