import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let envLoaded = false;
function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = resolve(__dirname, '../.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional; rely on real environment variables in production.
  }
}

loadEnvFile();

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  get port() {
    return Number(env('PORT', '3001'));
  },
  get host() {
    return env('HOST', '0.0.0.0');
  },
  get databaseUrl() {
    return env('DATABASE_URL', 'postgres://postgres@localhost:5432/incident_handoff');
  },
  get testDatabaseUrl() {
    return env('TEST_DATABASE_URL', 'postgres://postgres@localhost:5432/incident_handoff_test');
  },
};
