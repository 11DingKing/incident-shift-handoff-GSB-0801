import { v4 as uuid } from 'uuid';
import { Pool } from 'pg';
import { runMigrations } from './migrate.js';
import { config } from '../config.js';

const INCIDENT_ID = 'inc-gd-20260729-01';
const BASE_TIME = new Date('2026-07-29T08:00:00Z');

function iso(minutesFromBase: number): string {
  return new Date(BASE_TIME.getTime() + minutesFromBase * 60_000).toISOString();
}

export async function seed(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? config.databaseUrl;
  await runMigrations(url);

  // Use a dedicated pool so this works correctly when invoked for a different
  // database (e.g. the test database) than the one the app's singleton pool targets.
  const seedPool = new Pool({ connectionString: url });
  try {
    const client = await seedPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM audit_events WHERE incident_id=$1', [INCIDENT_ID]);
      await client.query('DELETE FROM supplementary_events WHERE incident_id=$1', [INCIDENT_ID]);
      await client.query(
        'DELETE FROM handoff_acknowledgments WHERE handoff_id IN (SELECT handoff_id FROM handoffs WHERE incident_id=$1)',
        [INCIDENT_ID],
      );
      await client.query(
        'DELETE FROM handoff_items WHERE handoff_id IN (SELECT handoff_id FROM handoffs WHERE incident_id=$1)',
        [INCIDENT_ID],
      );
      await client.query(
        'DELETE FROM handoff_timeline WHERE handoff_id IN (SELECT handoff_id FROM handoffs WHERE incident_id=$1)',
        [INCIDENT_ID],
      );
      await client.query('DELETE FROM handoffs WHERE incident_id=$1', [INCIDENT_ID]);
      await client.query('DELETE FROM timeline_events WHERE incident_id=$1', [INCIDENT_ID]);
      await client.query('DELETE FROM action_items WHERE incident_id=$1', [INCIDENT_ID]);
      await client.query('DELETE FROM incidents WHERE incident_id=$1', [INCIDENT_ID]);

      await client.query(
        `INSERT INTO incidents(incident_id, title, description, severity, status, occurred_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          INCIDENT_ID,
          '粤东片区强降水与强对流天气',
          '2026年7月29日起粤东片区出现大范围强降水并伴有强对流，需要跨班次持续处置，主路封闭、临时搭建物撤离与绕行路线复核并行推进。',
          'high',
          'active',
          iso(0),
        ],
      );

      const a1 = 'ai-gd-20260729-route-review';
      const a2 = 'ai-gd-20260729-temp-structure';
      await client.query(
        `INSERT INTO action_items(action_item_id, incident_id, title, description, status, owner, due_at, occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          a1, INCIDENT_ID,
          '复核东侧绕行路线',
          '联合交警复核东侧临时绕行路线的通行条件、积水点与指示标识，确认可承载主路封闭后的分流流量。',
          'in_progress',
          '应急协调组-李工',
          iso(180),
          iso(20),
        ],
      );
      await client.query(
        `INSERT INTO action_items(action_item_id, incident_id, title, description, status, owner, due_at, occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          a2, INCIDENT_ID,
          '确认临时搭建物撤离结果',
          '现场小组逐点确认施工围挡、临时棚架、广告牌骨架等已全部撤离或加固，并回传图像证据入库。',
          'open',
          '现场处置组-王组长',
          iso(120),
          iso(30),
        ],
      );

      await client.query(
        `INSERT INTO timeline_events(event_id, incident_id, event_type, summary, actor, occurred_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          'tl-gd-20260729-road-closure',
          INCIDENT_ID,
          'road_closure',
          '主路K42+300至K45+800段因积水与倒伏树木实施双向封闭，分流至东侧绕行路线。',
          '路网监测中心',
          iso(15),
        ],
      );
      await client.query(
        `INSERT INTO timeline_events(event_id, incident_id, event_type, summary, actor, occurred_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          'tl-gd-20260729-evidence-ingest',
          INCIDENT_ID,
          'evidence_ingested',
          '现场照片与视频12份已入库，证据包编号 EV-20260729-001，涵盖主路积水点与东侧路口。',
          '证据管理-赵值班',
          iso(45),
        ],
      );

      await client.query(
        `INSERT INTO audit_events(audit_id, incident_id, handoff_id, action, actor, payload)
         VALUES($1,$2,NULL,'seed','system',$3)`,
        [uuid(), INCIDENT_ID, JSON.stringify({ action_items: [a1, a2] })],
      );

      await client.query('COMMIT');
      console.log(`[seed] inserted incident ${INCIDENT_ID} with 2 action items and 2 timeline events`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await seedPool.end();
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      process.argv[1]?.replace(/\\/g, '/')?.endsWith('src/db/seed.ts');
  } catch {
    return false;
  }
})();

if (isMain) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed', err);
      process.exit(1);
    });
}
