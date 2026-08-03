import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { withTx } from '../db.js';
import { ApiError, type FieldConflict } from '../errors.js';
import { newId } from '../ids.js';

interface CreateBody {
  fromShift?: string;
  toShift?: string;
  note?: string;
  createdBy?: string;
  parentHandoffId?: string;
}

interface PatchHandoffBody {
  toShift?: string;
  note?: string;
  expectedVersion?: number;
}

interface SignBody {
  signedBy?: string;
  expectedVersion?: number;
}

interface ConfirmBody {
  confirmedBy?: string;
  expectedVersion?: number;
}

interface SupplementBody {
  title?: string;
  detail?: string;
  owner?: string;
  occurredAt?: string;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.badRequest(`${name} 必填且不能为空`);
  }
  return value.trim();
}

export function handoffRoutes(app: FastifyInstance, pool: Pool): void {
  // 创建交接包（草稿）
  app.post('/api/incidents/:incidentId/handoffs', async (req, reply) => {
    const { incidentId } = req.params as { incidentId: string };
    const body = (req.body ?? {}) as CreateBody;
    const fromShift = requireText(body.fromShift, 'fromShift');
    const toShift = requireText(body.toShift, 'toShift');
    const createdBy = requireText(body.createdBy, 'createdBy');
    const inc = await pool.query('SELECT id FROM incidents WHERE id = $1', [incidentId]);
    if (inc.rows.length === 0) throw ApiError.notFound('事件', incidentId);
    let parentHandoffId: string | null = null;
    if (body.parentHandoffId !== undefined) {
      parentHandoffId = requireText(body.parentHandoffId, 'parentHandoffId');
      const parent = await pool.query(
        'SELECT id, incident_id, status FROM handoffs WHERE id = $1',
        [parentHandoffId],
      );
      if (parent.rows.length === 0) throw ApiError.notFound('父交接包', parentHandoffId);
      if (parent.rows[0].incident_id !== incidentId) {
        throw ApiError.badRequest('父交接包不属于本事件');
      }
      if (parent.rows[0].status !== 'signed') {
        throw new ApiError(409, 'HANDOFF_NOT_SIGNED', '父交接包尚未签收，不能作为补充基准');
      }
    }
    const id = newId('ho');
    const { rows } = await pool.query(
      `INSERT INTO handoffs (id, incident_id, from_shift, to_shift, note, created_by, parent_handoff_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, incidentId, fromShift, toShift, body.note ?? '', createdBy, parentHandoffId],
    );
    return reply.code(201).send({ handoff: rows[0] });
  });

  // 交接包详情：草稿显示实时行动项；已签收显示签收时刻快照（不可变）
  app.get('/api/handoffs/:handoffId', async (req) => {
    const { handoffId } = req.params as { handoffId: string };
    const { rows } = await pool.query('SELECT * FROM handoffs WHERE id = $1', [handoffId]);
    const handoff = rows[0];
    if (!handoff) throw ApiError.notFound('交接包', handoffId);

    let items;
    if (handoff.status === 'signed') {
      items = (
        await pool.query(
          `SELECT hi.*, hi.action_item_id AS id FROM handoff_items hi
            WHERE hi.handoff_id = $1 ORDER BY hi.action_item_id`,
          [handoffId],
        )
      ).rows;
    } else {
      items = (
        await pool.query(
          `SELECT id, title, owner, status AS status_at_sign, version AS version_at_sign,
                  false AS confirmed, NULL AS confirmed_by, NULL AS confirmed_at
             FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, id`,
          [handoff.incident_id],
        )
      ).rows;
    }
    const supplements = (
      await pool.query(
        `SELECT * FROM timeline_events
          WHERE handoff_id = $1 AND kind = 'supplement' ORDER BY occurred_at, id`,
        [handoffId],
      )
    ).rows;

    // 补充交接包：附带父包信息与「新增 / 变更 / 未变化」对比视图
    let parent = null;
    let comparison = null;
    if (handoff.parent_handoff_id) {
      parent =
        (
          await pool.query('SELECT * FROM handoffs WHERE id = $1', [
            handoff.parent_handoff_id,
          ])
        ).rows[0] ?? null;
      if (handoff.status === 'signed' && parent) {
        const parentSnap = (
          await pool.query(
            `SELECT *, action_item_id AS id FROM handoff_items
              WHERE handoff_id = $1 ORDER BY action_item_id`,
            [parent.id],
          )
        ).rows;
        const childIds = new Set(items.map((i: { id: string }) => i.id));
        comparison = {
          added: items.filter((i: { change_kind: string }) => i.change_kind === 'added'),
          changed: items.filter((i: { change_kind: string }) => i.change_kind === 'changed'),
          unchanged: parentSnap.filter((p: { id: string }) => !childIds.has(p.id)),
          parentItems: parentSnap,
        };
      }
    }
    return { handoff, items, supplements, parent, comparison };
  });

  // 修改交接包：仅草稿可改，已签收一律 409 HANDOFF_LOCKED
  app.patch('/api/handoffs/:handoffId', async (req) => {
    const { handoffId } = req.params as { handoffId: string };
    const body = (req.body ?? {}) as PatchHandoffBody;
    if (typeof body.expectedVersion !== 'number') {
      throw ApiError.badRequest('expectedVersion（数字）必填');
    }
    return withTx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM handoffs WHERE id = $1 FOR UPDATE', [
        handoffId,
      ]);
      const current = rows[0];
      if (!current) throw ApiError.notFound('交接包', handoffId);
      if (current.status === 'signed') throw ApiError.locked('交接包', handoffId);
      if (current.version !== body.expectedVersion) {
        const conflicts: FieldConflict[] = [];
        if (body.toShift !== undefined && body.toShift !== current.to_shift) {
          conflicts.push({ field: 'toShift', current: current.to_shift, attempted: body.toShift });
        }
        if (body.note !== undefined && body.note !== current.note) {
          conflicts.push({ field: 'note', current: current.note, attempted: body.note });
        }
        throw ApiError.versionConflict('交接包', current.version, conflicts);
      }
      const updated = await c.query(
        `UPDATE handoffs SET to_shift = $2, note = $3, version = version + 1
          WHERE id = $1 RETURNING *`,
        [handoffId, body.toShift ?? current.to_shift, body.note ?? current.note],
      );
      return { handoff: updated.rows[0] };
    });
  });

  // 签收：快照 + 交接包状态 + 审计事件在同一事务内原子产生
  app.post('/api/handoffs/:handoffId/sign', async (req) => {
    const { handoffId } = req.params as { handoffId: string };
    const body = (req.body ?? {}) as SignBody;
    const signedBy = requireText(body.signedBy, 'signedBy');
    if (typeof body.expectedVersion !== 'number') {
      throw ApiError.badRequest('expectedVersion（数字）必填');
    }
    return withTx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM handoffs WHERE id = $1 FOR UPDATE', [
        handoffId,
      ]);
      const handoff = rows[0];
      if (!handoff) throw ApiError.notFound('交接包', handoffId);
      if (handoff.status === 'signed') {
        throw new ApiError(409, 'HANDOFF_ALREADY_SIGNED', '交接包已签收，不可重复签收', {
          signedAt: handoff.signed_at,
        });
      }
      if (handoff.version !== body.expectedVersion) {
        throw ApiError.versionConflict('交接包', handoff.version, []);
      }

      // 逐项快照：未确认事项默认 confirmed=false，不改动行动项状态；
      // 补充包只快照父签收之后新增或变化的内容，并保存与父快照的逐字段差异
      let snapCount = 0;
      if (handoff.parent_handoff_id) {
        const parentSnap = await c.query(
          'SELECT * FROM handoff_items WHERE handoff_id = $1',
          [handoff.parent_handoff_id],
        );
        const parentById = new Map(
          parentSnap.rows.map((r) => [r.action_item_id as string, r]),
        );
        const current = await c.query(
          'SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at, id',
          [handoff.incident_id],
        );
        for (const item of current.rows) {
          const p = parentById.get(item.id);
          let changeKind: 'added' | 'changed' | null = null;
          let diff: Record<string, { from: unknown; to: unknown }> = {};
          if (!p) {
            changeKind = 'added';
            diff = {
              title: { from: null, to: item.title },
              owner: { from: null, to: item.owner },
              status: { from: null, to: item.status },
            };
          } else if (p.version_at_sign !== item.version) {
            changeKind = 'changed';
            if (p.title !== item.title) diff.title = { from: p.title, to: item.title };
            if (p.owner !== item.owner) diff.owner = { from: p.owner, to: item.owner };
            if (p.status_at_sign !== item.status) {
              diff.status = { from: p.status_at_sign, to: item.status };
            }
          }
          if (!changeKind) continue; // 未变化项不进入补充快照
          const ins = await c.query(
            `INSERT INTO handoff_items
               (handoff_id, action_item_id, title, owner, status_at_sign, version_at_sign, change_kind, diff)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (handoff_id, action_item_id) DO NOTHING`,
            [
              handoffId,
              item.id,
              item.title,
              item.owner,
              item.status,
              item.version,
              changeKind,
              JSON.stringify(diff),
            ],
          );
          snapCount += ins.rowCount ?? 0;
        }
      } else {
        const snap = await c.query(
          `INSERT INTO handoff_items
             (handoff_id, action_item_id, title, owner, status_at_sign, version_at_sign)
           SELECT $1, id, title, owner, status, version FROM action_items
            WHERE incident_id = $2 ORDER BY occurred_at, id
           ON CONFLICT (handoff_id, action_item_id) DO NOTHING
           RETURNING action_item_id`,
          [handoffId, handoff.incident_id],
        );
        snapCount = snap.rowCount ?? 0;
      }
      const signed = await c.query(
        `UPDATE handoffs SET status = 'signed', signed_at = now(), version = version + 1
          WHERE id = $1 RETURNING *`,
        [handoffId],
      );
      const isSupplement = Boolean(handoff.parent_handoff_id);
      await c.query(
        `INSERT INTO timeline_events
           (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at)
         VALUES ($1, $2, $3, 'audit', $4, $5, $6, now())`,
        [
          newId('au'),
          handoff.incident_id,
          handoffId,
          isSupplement ? '补充交接包已签收' : '交接包已签收',
          isSupplement
            ? `${signedBy} 签收补充交接包（${handoff.from_shift} → ${handoff.to_shift}），基准父包 ${handoff.parent_handoff_id}，差异快照 ${snapCount} 项`
            : `${signedBy} 签收交接包（${handoff.from_shift} → ${handoff.to_shift}），快照 ${snapCount} 项行动项`,
          signedBy,
        ],
      );
      return { handoff: signed.rows[0], snapshotCount: snapCount };
    });
  });

  // 逐项确认：幂等——重复确认返回首次结果，不产生第二条审计记录
  app.post('/api/handoffs/:handoffId/items/:itemId/confirm', async (req) => {
    const { handoffId, itemId } = req.params as { handoffId: string; itemId: string };
    const body = (req.body ?? {}) as ConfirmBody;
    const confirmedBy = requireText(body.confirmedBy, 'confirmedBy');
    return withTx(pool, async (c) => {
      const h = await c.query('SELECT * FROM handoffs WHERE id = $1 FOR UPDATE', [handoffId]);
      const handoff = h.rows[0];
      if (!handoff) throw ApiError.notFound('交接包', handoffId);
      if (handoff.status !== 'signed') {
        throw new ApiError(409, 'HANDOFF_NOT_SIGNED', '交接包尚未签收，不能确认');
      }
      const hi = await c.query(
        `SELECT * FROM handoff_items
          WHERE handoff_id = $1 AND action_item_id = $2 FOR UPDATE`,
        [handoffId, itemId],
      );
      const item = hi.rows[0];
      if (!item) throw ApiError.notFound('交接快照项', itemId);
      // 携带旧版本（如签收前的草稿版本）→ 409，返回字段级当前值
      if (body.expectedVersion !== undefined) {
        if (typeof body.expectedVersion !== 'number') {
          throw ApiError.badRequest('expectedVersion 必须是数字');
        }
        if (handoff.version !== body.expectedVersion) {
          throw ApiError.versionConflict('交接包', handoff.version, [
            {
              field: 'handoffVersion',
              current: handoff.version,
              attempted: body.expectedVersion,
            },
            { field: 'confirmed', current: item.confirmed, attempted: true },
            { field: 'confirmedBy', current: item.confirmed_by, attempted: confirmedBy },
            { field: 'confirmedAt', current: item.confirmed_at, attempted: null },
          ]);
        }
      }
      if (item.confirmed) {
        // 幂等：不覆盖首次确认人与确认时间
        return { item, alreadyConfirmed: true };
      }
      const updated = await c.query(
        `UPDATE handoff_items
            SET confirmed = true, confirmed_by = $3, confirmed_at = now()
          WHERE handoff_id = $1 AND action_item_id = $2 RETURNING *`,
        [handoffId, itemId, confirmedBy],
      );
      await c.query(
        `INSERT INTO timeline_events
           (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at)
         VALUES ($1, $2, $3, 'audit', '行动项已确认', $4, $5, now())`,
        [
          newId('au'),
          handoff.incident_id,
          handoffId,
          `${confirmedBy} 确认「${item.title}」（${itemId}）`,
          confirmedBy,
        ],
      );
      return { item: updated.rows[0], alreadyConfirmed: false };
    });
  });

  // 追加补充事件：必须关联一个已签收的交接包
  app.post('/api/handoffs/:handoffId/supplements', async (req, reply) => {
    const { handoffId } = req.params as { handoffId: string };
    const body = (req.body ?? {}) as SupplementBody;
    const title = requireText(body.title, 'title');
    const owner = requireText(body.owner, 'owner');
    const occurredAt = body.occurredAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(occurredAt))) {
      throw ApiError.badRequest('occurredAt 必须是合法时间');
    }
    const event = await withTx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM handoffs WHERE id = $1', [handoffId]);
      const handoff = rows[0];
      if (!handoff) throw ApiError.notFound('交接包', handoffId);
      if (handoff.status !== 'signed') {
        throw new ApiError(409, 'HANDOFF_NOT_SIGNED', '交接包未签收，补充事件无从关联');
      }
      const inserted = await c.query(
        `INSERT INTO timeline_events
           (id, incident_id, handoff_id, kind, title, detail, owner, occurred_at)
         VALUES ($1, $2, $3, 'supplement', $4, $5, $6, $7) RETURNING *`,
        [newId('sp'), handoff.incident_id, handoffId, title, body.detail ?? '', owner, occurredAt],
      );
      return inserted.rows[0];
    });
    return reply.code(201).send({ event });
  });
}
