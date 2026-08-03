import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');

/**
 * Ensure the test schema exists (migrations applied against TEST_DATABASE_URL).
 * Run once before the suite.
 */
export function ensureSchema(): void {
  execFileSync('npx', ['tsx', 'src/migrate.ts'], {
    cwd: backendRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
}

/** Truncate all data and re-insert the canonical initial incident. */
export async function resetData(): Promise<void> {
  await pool.query(`
    TRUNCATE idempotency_keys, audit_events, supplemental_handoffs, supplemental_events,
             acknowledgements, handoffs, timeline_events, action_items, incidents
             RESTART IDENTITY CASCADE;
  `);

  await pool.query(
    `INSERT INTO incidents (id, title, severity, status, responsible_party, occurred_at)
     VALUES ('inc-gd-20260729-01', '广东强降水与强对流应急事件', 'high', 'active', '应急指挥中心', '2026-07-29T02:00:00.000Z')`,
  );
  await pool.query(
    `INSERT INTO action_items (id, incident_id, title, detail, status, responsible_party, occurred_at)
     VALUES
       ('act-gd-20260729-01-a1', 'inc-gd-20260729-01', '复核东侧绕行路线', '', 'in_progress', '交通协调组', '2026-07-29T02:30:00.000Z'),
       ('act-gd-20260729-01-a2', 'inc-gd-20260729-01', '确认临时搭建物撤离结果', '', 'open', '现场处置组', '2026-07-29T03:10:00.000Z')`,
  );
  await pool.query(
    `INSERT INTO timeline_events (id, incident_id, kind, description, responsible_party, evidence_uri, occurred_at, recorded_at)
     VALUES
       ('tl-gd-20260729-01-e1', 'inc-gd-20260729-01', 'road_closure', '主路封闭', '交通协调组', NULL, '2026-07-29T02:20:00.000Z', '2026-07-29T02:25:00.000Z'),
       ('tl-gd-20260729-01-e2', 'inc-gd-20260729-01', 'evidence_intake', '现场证据入库', '现场处置组', 's3://e', '2026-07-29T03:00:00.000Z', '2026-07-29T03:45:00.000Z')`,
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
