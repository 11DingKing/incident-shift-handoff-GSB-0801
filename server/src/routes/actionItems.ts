import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTx } from '../db.js';
import { ApiError, type FieldConflict } from '../errors.js';
import { newId } from '../ids.js';

const ITEM_STATUSES = ['open', 'in_progress', 'done', 'verified'] as const;
type ItemStatus = (typeof ITEM_STATUSES)[number];

interface PatchBody {
  title?: string;
  owner?: string;
  status?: ItemStatus;
  expectedVersion?: number;
  updatedBy?: string;
}

export function actionItemRoutes(app: FastifyInstance, pool: Pool): void {
  // 更新行动项：乐观版本号 + 字段级冲突 + 签收后自动追加补充事件
  app.patch('/api/action-items/:itemId', async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const body = (req.body ?? {}) as PatchBody;
    if (typeof body.expectedVersion !== 'number') {
      throw ApiError.badRequest('expectedVersion（数字）必填');
    }
    if (body.status !== undefined && !ITEM_STATUSES.includes(body.status)) {
      throw ApiError.badRequest(`status 必须是 ${ITEM_STATUSES.join(' / ')}`);
    }
    if (body.title !== undefined && body.title.trim() === '') {
      throw ApiError.badRequest('title 不能为空');
    }
    if (body.owner !== undefined && body.owner.trim() === '') {
      throw ApiError.badRequest('owner 不能为空');
    }

    const result = await withTx(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM action_items WHERE id = $1 FOR UPDATE',
        [itemId],
      );
      const current = rows[0];
      if (!current) throw ApiError.notFound('行动项', itemId);

      if (current.version !== body.expectedVersion) {
        const conflicts: FieldConflict[] = [];
        for (const field of ['title', 'owner', 'status'] as const) {
          const attempted = body[field];
          if (attempted !== undefined && attempted !== current[field]) {
            conflicts.push({ field, current: current[field], attempted });
          }
        }
        throw ApiError.versionConflict('行动项', current.version, conflicts);
      }

      const next = {
        title: body.title ?? current.title,
        owner: body.owner ?? current.owner,
        status: body.status ?? current.status,
      };
      const updated = await c.query(
        `UPDATE action_items
           SET title = $2, owner = $3, status = $4, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [itemId, next.title, next.owner, next.status],
      );

      // 若该行动项已被某签收交接包覆盖，变化必须追加为补充事件并关联原交接包
      const signed = await c.query(
        `SELECT h.id FROM handoffs h
           JOIN handoff_items hi ON hi.handoff_id = h.id AND hi.action_item_id = $1
          WHERE h.incident_id = $2 AND h.status = 'signed'
          ORDER BY h.signed_at DESC LIMIT 1`,
        [itemId, current.incident_id],
      );
      if (signed.rows.length > 0) {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const field of ['title', 'owner', 'status'] as const) {
          if (next[field] !== current[field]) {
            changes[field] = { from: current[field], to: next[field] };
          }
        }
        if (Object.keys(changes).length > 0) {
          await c.query(
            `INSERT INTO timeline_events
               (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at)
             VALUES ($1, $2, $3, 'supplement', $4, $5, $6, now())`,
            [
              newId('sp'),
              current.incident_id,
              signed.rows[0].id,
              `行动项更新：${next.title}`,
              JSON.stringify({ actionItemId: itemId, changes }),
              body.updatedBy ?? next.owner,
            ],
          );
        }
      }
      return updated.rows[0];
    });

    return reply.code(200).send({ actionItem: result });
  });
}
