import { Pool } from 'pg';
import { config } from '../src/config.js';
import { seed } from '../src/db/seed.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let testPool: Pool | null = null;

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: config.testDatabaseUrl });
  }
  return testPool;
}

export async function resetDatabase(): Promise<void> {
  const pool = getTestPool();
  await pool.query(`
    DO $$ DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
  process.env.DATABASE_URL = config.testDatabaseUrl;
  await seed(config.testDatabaseUrl);
}

export async function buildTestApp(): Promise<FastifyInstance> {
  process.env.DATABASE_URL = config.testDatabaseUrl;
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function closeTestApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

export async function endTestPool(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = null;
  }
}
