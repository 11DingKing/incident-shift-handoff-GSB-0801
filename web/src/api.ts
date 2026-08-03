import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody['error'],
  ) {
    super(body.message);
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: '网络错误，可安全重试' });
  }
  const data = (await res.json()) as T & ApiErrorBody;
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? { code: 'UNKNOWN', message: '未知错误' });
  }
  return data;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown, idempotencyKey?: string) =>
    request<T>('POST', url, body, idempotencyKey),
  patch: <T>(url: string, body: unknown, idempotencyKey?: string) =>
    request<T>('PATCH', url, body, idempotencyKey),
};

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
