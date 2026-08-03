// Vitest global setup: runs before any test module is imported.
// Force the app's singleton pool to target the test database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/incident_handoff_test';
process.env.NODE_ENV = 'test';
