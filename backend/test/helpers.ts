import { buildApp } from "../src/app.js";
import { pool, withTransaction } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import type { FastifyInstance } from "fastify";

export const INCIDENT_ID = "inc-gd-20260729-01";
export const ACTION_ITEM_1 = "act-gd-20260729-01-a1";
export const ACTION_ITEM_2 = "act-gd-20260729-01-a2";
export const TIMELINE_1 = "tl-gd-20260729-01-e1";
export const TIMELINE_2 = "tl-gd-20260729-01-e2";

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
}

export async function resetDatabase(): Promise<void> {
  await pool.query(`TRUNCATE
    audit_events,
    idempotency_keys,
    acknowledgements,
    supplemental_events,
    supplemental_handoffs,
    handoffs,
    timeline_events,
    action_item_revisions,
    action_items,
    incidents
    RESTART IDENTITY CASCADE`);

  await pool.query(
    `INSERT INTO incidents
       (id, title, severity, status, responsible_party, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      INCIDENT_ID,
      "广东强降水与强对流应急事件",
      "high",
      "active",
      "应急指挥中心",
      "2026-07-29T10:00:00+08:00",
    ]
  );

  await pool.query(
    `INSERT INTO action_items
       (id, incident_id, title, detail, status, responsible_party, occurred_at)
     VALUES
       ($1,$2,$3,$4,'in_progress',$5,$6),
       ($7,$2,$8,$9,'open',$10,$11)`,
    [
      ACTION_ITEM_1,
      INCIDENT_ID,
      "复核东侧绕行路线",
      "复核东侧绕行道路通行条件与导流标识。",
      "交通协调组",
      "2026-07-29T10:05:00+08:00",
      ACTION_ITEM_2,
      "确认临时搭建物撤离结果",
      "逐点确认临时搭建物人员与物资撤离完成。",
      "现场处置组",
      "2026-07-29T10:10:00+08:00",
    ]
  );

  await pool.query(
    `INSERT INTO timeline_events
       (id, incident_id, kind, description, responsible_party, occurred_at)
     VALUES
       ($1,$2,'road_closure',$3,$4,$5),
       ($6,$2,'evidence_intake',$7,$8,$9)`,
    [
      TIMELINE_1,
      INCIDENT_ID,
      "主路（G某段）因积水封闭，双向禁止通行。",
      "交通协调组",
      "2026-07-29T10:20:00+08:00",
      TIMELINE_2,
      "现场巡查证据（积水深度照片与视频）入库。",
      "现场处置组",
      "2026-07-29T11:00:00+08:00",
    ]
  );

  await pool.query(
    `INSERT INTO action_item_revisions
       (action_item_id, version, title, detail, status, responsible_party, occurred_at)
     SELECT id, version, title, detail, status, responsible_party, occurred_at
     FROM action_items`
  );
}

export function makeApp(): FastifyInstance {
  return buildApp();
}

export async function closeApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

export async function query<T = unknown>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

export { withTransaction };
