import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:55432/handoff_test';

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
}

// 每个测试文件使用独立数据库，避免并行重置互相踩踏
export async function makeContext(dbName: string): Promise<TestContext> {
  const adminUrl = new URL(TEST_DATABASE_URL);
  const admin = createPool(TEST_DATABASE_URL);
  const { rows } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  );
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  adminUrl.pathname = `/${dbName}`;
  const url = adminUrl.toString();
  const scoped = createPool(url);
  await scoped.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await scoped.end();
  await admin.end();
  await migrate(url);
  const pool = createPool(url);
  const app = await buildApp(pool);
  return { app, pool };
}

export async function closeContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

export const INCIDENT = 'inc-gd-20260729-01';
export const ITEM_ROUTE = 'ai-gd-20260729-01';
export const ITEM_SCAFFOLD = 'ai-gd-20260729-02';

export async function createHandoff(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/incidents/${INCIDENT}/handoffs`,
    payload: { fromShift: '白班', toShift: '夜班', note: '持续强降水', createdBy: '班长A' },
  });
  return (res.json() as { handoff: { id: string } }).handoff.id;
}

export async function signHandoff(
  app: FastifyInstance,
  handoffId: string,
  signedBy = '班长B',
  expectedVersion = 1,
) {
  return app.inject({
    method: 'POST',
    url: `/api/handoffs/${handoffId}/sign`,
    payload: { signedBy, expectedVersion },
  });
}
