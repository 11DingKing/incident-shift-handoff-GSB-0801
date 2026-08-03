import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://huangding@localhost:5432/incident_handoff_gsb_0801_test",
      NODE_ENV: "test",
      CORS_ORIGIN: "http://localhost:5173",
      PORT: "0",
      LOG_LEVEL: "silent",
    },
  },
});
