import { Pool } from "pg";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://huangding@localhost:5432/incident_handoff_gsb_0801_test";

const INCIDENT_ID = "inc-gd-20260729-01";
const A1 = "act-gd-20260729-01-a1";
const A2 = "act-gd-20260729-01-a2";
const T1 = "tl-gd-20260729-01-e1";
const T2 = "tl-gd-20260729-01-e2";

export async function resetDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(`TRUNCATE
      audit_events, idempotency_keys, acknowledgements,
      supplemental_events, supplemental_handoffs, handoffs,
      timeline_events, action_item_revisions, action_items, incidents
      RESTART IDENTITY CASCADE`);

    await pool.query(
      `INSERT INTO incidents
         (id, title, severity, status, responsible_party, occurred_at)
       VALUES ($1,$2,'high','active',$3,$4)`,
      [
        INCIDENT_ID,
        "广东强降水与强对流应急事件",
        "应急指挥中心",
        "2026-07-29T10:00:00+08:00",
      ],
    );
    await pool.query(
      `INSERT INTO action_items
         (id, incident_id, title, detail, status, responsible_party, occurred_at)
       VALUES
         ($1,$2,'复核东侧绕行路线','','in_progress','交通协调组','2026-07-29T10:05:00+08:00'),
         ($3,$2,'确认临时搭建物撤离结果','','open','现场处置组','2026-07-29T10:10:00+08:00')`,
      [A1, INCIDENT_ID, A2],
    );
    await pool.query(
      `INSERT INTO timeline_events
         (id, incident_id, kind, description, responsible_party, occurred_at)
       VALUES
         ($1,$2,'road_closure','主路（G某段）因积水封闭，双向禁止通行。','交通协调组','2026-07-29T10:20:00+08:00'),
         ($3,$2,'evidence_intake','现场巡查证据（积水深度照片与视频）入库。','现场处置组','2026-07-29T11:00:00+08:00')`,
      [T1, INCIDENT_ID, T2],
    );
    await pool.query(
      `INSERT INTO action_item_revisions
         (action_item_id, version, title, detail, status, responsible_party, occurred_at)
       SELECT id, version, title, detail, status, responsible_party, occurred_at
       FROM action_items`,
    );
  } finally {
    await pool.end();
  }
}
