import type { PoolClient } from "pg";
import { withTransaction, pool } from "../db.js";
import type {
  ActionItem,
  ActionItemStatus,
  FieldConflict,
  AuditEvent,
} from "../types.js";
import { OptimisticLockError, NotFoundError } from "../types.js";
import * as actionItemRepo from "../repositories/actionItemRepo.js";
import * as incidentRepo from "../repositories/incidentRepo.js";
import * as handoffRepo from "../repositories/handoffRepo.js";
import * as auditRepo from "../repositories/auditRepo.js";
import { ids } from "../ids.js";
import { eventBus } from "./eventBus.js";
import { createAuditEvent } from "../repositories/auditRepo.js";

const MUTABLE_FIELDS = [
  "title",
  "detail",
  "status",
  "responsible_party",
  "occurred_at",
] as const;
type MutableField = (typeof MUTABLE_FIELDS)[number];

function isMutableField(key: string): key is MutableField {
  return (MUTABLE_FIELDS as readonly string[]).includes(key);
}

function normalizeOccurredAt(value: string | undefined): string | undefined {
  if (!value) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error("occurred_at 不是合法时间");
  }
  return d.toISOString();
}

async function ensureSupplementalHandoff(
  client: PoolClient,
  parent: { id: string; incident_id: string; from_shift: string; to_shift: string },
  diff: Record<string, unknown>,
  actor: string
): Promise<string> {
  const existing = await handoffRepo.getSupplementalHandoffByParent(
    client,
    parent.id
  );
  if (existing) return existing.id;
  const created = await handoffRepo.createSupplementalHandoff(client, {
    id: ids.supplementalHandoff(),
    incident_id: parent.incident_id,
    parent_handoff_id: parent.id,
    from_shift: parent.to_shift,
    to_shift: parent.from_shift,
    summary: "签收后追加变化",
    diff,
    created_by: actor,
  });
  if (created) {
    await createAuditEvent(client, {
      incident_id: parent.incident_id,
      handoff_id: parent.id,
      event_type: "supplemental_handoff.created",
      actor,
      payload: { supplemental_handoff_id: created.id },
    });
    eventBus.publish({
      type: "supplemental_handoff.created",
      incident_id: parent.incident_id,
      payload: { supplemental_handoff_id: created.id, parent_handoff_id: parent.id },
    });
    return created.id;
  }
  const winner = await handoffRepo.getSupplementalHandoffByParent(
    client,
    parent.id
  );
  return winner!.id;
}

async function latestSignedHandoff(
  client: PoolClient,
  incidentId: string
) {
  const { rows } = await client.query<{
    id: string;
    from_shift: string;
    to_shift: string;
  }>(
    `SELECT id, from_shift, to_shift FROM handoffs
     WHERE incident_id = $1 AND status = 'signed'
     ORDER BY signed_off_at DESC, created_at DESC
     LIMIT 1`,
    [incidentId]
  );
  return rows[0] ?? null;
}

export interface UpdateActionItemInput {
  id: string;
  expectedVersion: number;
  patch: Partial<{
    title: string;
    detail: string;
    status: ActionItemStatus;
    responsible_party: string;
    occurred_at: string;
  }>;
  actor: string;
}

export interface UpdateActionItemResult {
  action_item: ActionItem;
  supplemental_event_id?: string;
}

export async function updateActionItem(
  input: UpdateActionItemInput
): Promise<UpdateActionItemResult> {
  const { id, expectedVersion, patch, actor } = input;

  for (const key of Object.keys(patch)) {
    if (!isMutableField(key)) {
      throw new Error(`字段 ${key} 不允许修改`);
    }
  }
  if (patch.status && !["open", "in_progress", "blocked", "done"].includes(patch.status)) {
    throw new Error("非法的行动项状态");
  }
  const normalizedPatch: actionItemRepo.ActionItemPatch = { ...patch };
  if (patch.occurred_at) {
    normalizedPatch.occurred_at = normalizeOccurredAt(patch.occurred_at);
  }

  return withTransaction(async (client) => {
    const current = await actionItemRepo.getActionItemForUpdate(client, id);
    if (!current) {
      throw new NotFoundError(`行动项 ${id} 不存在`);
    }

    if (expectedVersion !== current.version) {
      const base = await actionItemRepo.getRevision(
        client,
        id,
        expectedVersion
      );
      const conflicts: FieldConflict[] = [];
      for (const key of Object.keys(normalizedPatch) as MutableField[]) {
        const baseValue = base ? (base as unknown as Record<string, unknown>)[key] : null;
        const currentValue = (current as unknown as Record<string, unknown>)[key];
        const attempted = (normalizedPatch as unknown as Record<string, unknown>)[key];
        if (base && JSON.stringify(baseValue) !== JSON.stringify(currentValue)) {
          conflicts.push({
            field: key,
            base: baseValue,
            current: currentValue,
            attempted,
          });
        } else if (!base) {
          conflicts.push({
            field: key,
            base: null,
            current: currentValue,
            attempted,
          });
        }
      }
      throw new OptimisticLockError(
        `行动项 ${id} 版本冲突：当前版本 ${current.version}，提交基于版本 ${expectedVersion}`,
        current.version,
        conflicts,
        current
      );
    }

    const before = { ...current };
    const updated = await actionItemRepo.updateActionItem(
      client,
      id,
      expectedVersion,
      normalizedPatch
    );
    if (!updated) {
      throw new OptimisticLockError(
        `行动项 ${id} 更新失败（并发冲突）`,
        current.version,
        [],
        current
      );
    }
    await actionItemRepo.insertRevision(client, updated);

    const changedFields = (Object.keys(normalizedPatch) as MutableField[]).filter(
      (f) =>
        JSON.stringify((before as unknown as Record<string, unknown>)[f]) !==
        JSON.stringify((updated as unknown as Record<string, unknown>)[f])
    );

    let supplementalEventId: string | undefined;
    const signed = await latestSignedHandoff(client, current.incident_id);
    if (signed) {
      const diff = {
        action_item_changes: [
          {
            id: updated.id,
            fields: changedFields,
            from: Object.fromEntries(
              changedFields.map((f) => [f, (before as unknown as Record<string, unknown>)[f]])
            ),
            to: Object.fromEntries(
              changedFields.map((f) => [f, (updated as unknown as Record<string, unknown>)[f]])
            ),
            at: updated.updated_at,
          },
        ],
        generated_at: new Date().toISOString(),
      };
      const shId = await ensureSupplementalHandoff(
        client,
        {
          id: signed.id,
          incident_id: current.incident_id,
          from_shift: signed.from_shift,
          to_shift: signed.to_shift,
        },
        diff,
        actor
      );
      const se = await handoffRepo.createSupplementalEvent(client, {
        id: ids.supplementalEvent(),
        incident_id: current.incident_id,
        parent_handoff_id: signed.id,
        kind: "action_item_updated",
        description: `行动项「${updated.title}」更新：${changedFields.join(", ")}`,
        responsible_party: actor,
        occurred_at: updated.updated_at,
      });
      supplementalEventId = se.id;
      await createAuditEvent(client, {
        incident_id: current.incident_id,
        handoff_id: signed.id,
        event_type: "supplemental_event.created",
        actor,
        payload: {
          supplemental_event_id: se.id,
          supplemental_handoff_id: shId,
          action_item_id: updated.id,
          changed_fields: changedFields,
        },
      });
    }

    const audit: Omit<AuditEvent, "id" | "created_at"> = {
      incident_id: current.incident_id,
      handoff_id: signed?.id ?? null,
      event_type: "action_item.updated",
      actor,
      payload: {
        action_item_id: updated.id,
        version: updated.version,
        changed_fields: changedFields,
      },
    };
    await auditRepo.createAuditEvent(client, audit);

    eventBus.publish({
      type: "action_item.updated",
      incident_id: current.incident_id,
      payload: {
        action_item_id: updated.id,
        version: updated.version,
        changed_fields: changedFields,
      },
    });

    return { action_item: updated, supplemental_event_id: supplementalEventId };
  });
}

export async function getActionItem(id: string): Promise<ActionItem | null> {
  const client = await pool.connect();
  try {
    return actionItemRepo.getActionItem(client, id);
  } finally {
    client.release();
  }
}

export async function listActionItems(
  incidentId: string
): Promise<ActionItem[]> {
  const client = await pool.connect();
  try {
    return incidentRepo.listActionItems(client, incidentId);
  } finally {
    client.release();
  }
}
