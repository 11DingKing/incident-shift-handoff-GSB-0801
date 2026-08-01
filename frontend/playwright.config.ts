import { defineConfig } from '@playwright/test';

// Backend runs against the TEST database with the guarded reset route enabled,
// on a dedicated port so it never collides with a running dev backend (:8080).
const API_PORT = 8199;
const WEB_PORT = 5199;

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'off',
  },
  webServer: [
    {
      // Start the backend from source via tsx against the test DB.
      command: 'npm run migrate && node --import tsx src/index.ts',
      cwd: '../backend',
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        NODE_ENV: 'test',
        ALLOW_TEST_RESET: '1',
        PORT: String(API_PORT),
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: 'npm run dev -- --port ' + WEB_PORT,
      cwd: '.',
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 60000,
      env: {
        VITE_API_PORT: String(API_PORT),
      },
    },
  ],
});
