import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader so we do not need a runtime dependency. Only sets keys
 * that are not already present in process.env (real env always wins).
 */
function loadDotEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env file – rely on the real environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  databaseUrl:
    (isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL) ??
    process.env.DATABASE_URL ??
    'postgres://huangding@localhost:5432/incident_handoff_gsb_0801_dev',
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8080),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
