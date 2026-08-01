import { pool } from './db.js';

/**
 * Seeds the initial incident inc-gd-20260729-01 with two action items and two
 * timeline events. Idempotent: re-running does nothing once the incident exists.
 */
async function main(): Promise<void> {
  const existing = await pool.query('SELECT 1 FROM incidents WHERE id = $1', [
    'inc-gd-20260729-01',
  ]);
  if (existing.rows.length > 0) {
    console.log('seed: inc-gd-20260729-01 already exists, skipping');
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO incidents (id, title, severity, status, responsible_party, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      'inc-gd-20260729-01',
      '广东强降水与强对流应急事件',
      'high',
      'active',
      '应急指挥中心',
      '2026-07-29T02:00:00.000Z',
    ],
  );

  await pool.query(
    `INSERT INTO action_items (id, incident_id, title, detail, status, responsible_party, occurred_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7),
       ($8, $2, $9, $10, $11, $12, $13)`,
    [
      'act-gd-20260729-01-a1',
      'inc-gd-20260729-01',
      '复核东侧绕行路线',
      '主路封闭后确认东侧绕行路线通行能力与交通引导标识是否到位。',
      'in_progress',
      '交通协调组',
      '2026-07-29T02:30:00.000Z',
      'act-gd-20260729-01-a2',
      '确认临时搭建物撤离结果',
      '核实低洼区域临时搭建物是否已全部撤离并留存现场照片。',
      'open',
      '现场处置组',
      '2026-07-29T03:10:00.000Z',
    ],
  );

  await pool.query(
    `INSERT INTO timeline_events
       (id, incident_id, kind, description, responsible_party, evidence_uri, occurred_at, recorded_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8),
       ($9, $2, $10, $11, $12, $13, $14, $15)`,
    [
      'tl-gd-20260729-01-e1',
      'inc-gd-20260729-01',
      'road_closure',
      '主路（G某段）因积水封闭，双向禁止通行。',
      '交通协调组',
      null,
      '2026-07-29T02:20:00.000Z',
      '2026-07-29T02:25:00.000Z',
      'tl-gd-20260729-01-e2',
      'evidence_intake',
      '现场巡查证据（积水深度照片与视频）入库。',
      '现场处置组',
      's3://evidence/inc-gd-20260729-01/e2.zip',
      '2026-07-29T03:00:00.000Z',
      '2026-07-29T03:45:00.000Z',
    ],
  );

  console.log('seed: created inc-gd-20260729-01 with 2 action items and 2 timeline events');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
