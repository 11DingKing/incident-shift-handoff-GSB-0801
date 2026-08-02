import { test as base, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '../../backend');

async function resetDb() {
  // Re-run migrations + seed against the dev database through the backend CLI.
  await exec('npm', ['run', 'seed'], { cwd: backendDir, env: process.env });
}

export const test = base.extend<{ resetDb: () => Promise<void> }>({
  resetDb: async ({}, use) => {
    await use(resetDb);
  },
});

export { expect };
