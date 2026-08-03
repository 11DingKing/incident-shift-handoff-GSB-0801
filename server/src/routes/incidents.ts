import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';

export function incidentRoutes(app: FastifyInstance, pool: Pool): void {
  // 事件总览：事件 + 行动项 + 交接包列表
  app.get('/api/incidents/:incidentId', async (req) => {
    const { incidentId } = req.params as { incidentId: string };
    const inc = await pool.query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
    if (inc.rows.length === 0) throw ApiError.notFound('事件', incidentId);
    const items = await pool.query(
      'SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, id',
      [incidentId],
    );
    const handoffs = await pool.query(
      'SELECT * FROM handoffs WHERE incident_id = $1 ORDER BY created_at, id',
      [incidentId],
    );
    return { incident: inc.rows[0], actionItems: items.rows, handoffs: handoffs.rows };
  });

  // 证据时间线（含补充事件与审计事件）
  app.get('/api/incidents/:incidentId/timeline', async (req) => {
    const { incidentId } = req.params as { incidentId: string };
    const inc = await pool.query('SELECT id FROM incidents WHERE id = $1', [incidentId]);
    if (inc.rows.length === 0) throw ApiError.notFound('事件', incidentId);
    const { rows } = await pool.query(
      'SELECT * FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at, id',
      [incidentId],
    );
    return { events: rows };
  });
}
