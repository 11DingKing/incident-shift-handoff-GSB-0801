import { defineConfig } from "@playwright/test";

const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://huangding@localhost:5432/incident_handoff_gsb_0801_test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: "./tests/global-setup.ts",
  webServer: [
    {
      command: "npx tsx src/index.ts",
      cwd: "../backend",
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        PORT: "4000",
        CORS_ORIGIN: "http://localhost:5173",
        LOG_LEVEL: "warn",
      },
      url: "http://localhost:4000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: "npm run dev -- --port 5173 --strictPort",
      cwd: ".",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    video: "off",
  },
});
