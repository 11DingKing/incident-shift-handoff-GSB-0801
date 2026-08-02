import type { PoolClient } from "pg";
import { withTransaction, pool } from "../db.js";
import type {
  Handoff,
  Acknowledgement,
  SupplementalEvent,
  SupplementalHandoff,
  ItemType,
  SnapshotData,
  ActionItem,
  TimelineEvent,
  AuditEvent,
  SupplementalDiff,
  ChangedActionItem,
  FieldConflict,
} from "../types.js";
import {
  NotFoundError,
  ValidationError,
  ImmutableResourceError,
  OptimisticLockError,
} from "../types.js";
import * as incidentRepo from "../repositories/incidentRepo.js";
import * as handoffRepo from "../repositories/handoffRepo.js";
import * as actionItemRepo from "../repositories/actionItemRepo.js";
import * as auditRepo from "../repositories/auditRepo.js";
import { ids } from "../ids.js";
import { eventBus } from "./eventBus.js";
import { withIdempotency } from "./idempotency.js";

export interface CreateHandoffInput {
  incident_id: string;
  from_shift: string;
  to_shift: string;
  summary: string;
  created_by: string;
}

export interface HandoffDetail {
  handoff: Handoff;
  acknowledgements: Acknowledgement[];
  supplemental_acknowledgements: Acknowledgement[];
  supplemental_events: SupplementalEvent[];
  supplemental_handoff: import("../types.js").SupplementalHandoff | null;
}

export async function createHandoff(
  input: CreateHandoffInput,
  idempotencyKey?: string,
): Promise<Handoff> {
  if (
    !input.incident_id ||
    !input.from_shift ||
    !input.to_shift ||
    !input.created_by
  ) {
    throw new ValidationError("缺少必需的交接包字段");
  }
  return withTransaction(async (client) => {
    const incident = await incidentRepo.getIncident(client, input.incident_id);
    if (!incident) {
      throw new NotFoundError(`事件 ${input.incident_id} 不存在`);
    }
    const { result } = await withIdempotency(
      client,
      idempotencyKey,
      `handoff:create:${input.incident_id}`,
      async () => {
        const handoff = await handoffRepo.createHandoff(client, {
          id: ids.handoff(),
          incident_id: input.incident_id,
          from_shift: input.from_shift,
          to_shift: input.to_shift,
          summary: input.summary,
          created_by: input.created_by,
        });
        await auditRepo.createAuditEvent(client, {
          incident_id: input.incident_id,
          handoff_id: handoff.id,
          event_type: "handoff.created",
          actor: input.created_by,
          payload: { handoff_id: handoff.id },
        });
        eventBus.publish({
          type: "handoff.created",
          incident_id: input.incident_id,
          payload: { handoff_id: handoff.id },
        });
        return handoff;
      },
    );
    return result;
  });
}

function buildSnapshot(
  incident: NonNullable<Awaited<ReturnType<typeof incidentRepo.getIncident>>>,
  actionItems: ActionItem[],
  timelineEvents: TimelineEvent[],
): SnapshotData {
  return {
    incident,
    action_items: actionItems,
    timeline_events: timelineEvents,
    captured_at: new Date().toISOString(),
  };
}

export async function signHandoff(
  handoffId: string,
  actor: string,
  idempotencyKey?: string,
): Promise<Handoff> {
  return withTransaction(async (client) => {
    const existing = await handoffRepo.getHandoffForUpdate(client, handoffId);
    if (!existing) {
      throw new NotFoundError(`交接包 ${handoffId} 不存在`);
    }
    if (existing.status === "signed") {
      return existing;
    }

    const { result } = await withIdempotency(
      client,
      idempotencyKey,
      `handoff:sign:${handoffId}`,
      async () => {
        const incident = await incidentRepo.getIncident(
          client,
          existing.incident_id,
        );
        if (!incident) {
          throw new NotFoundError(`事件 ${existing.incident_id} 不存在`);
        }
        const actionItems = await incidentRepo.listActionItems(
          client,
          existing.incident_id,
        );
        const timelineEvents = await incidentRepo.listTimelineEvents(
          client,
          existing.incident_id,
        );

        const signEvent: TimelineEvent = {
          id: ids.timelineEvent(),
          incident_id: existing.incident_id,
          kind: "handoff_signed",
          description: `交接包 ${handoffId} 由 ${actor} 签收，快照已固化。`,
          responsible_party: actor,
          evidence_uri: null,
          occurred_at: new Date().toISOString(),
          recorded_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        const snapshot = buildSnapshot(incident, actionItems, [
          ...timelineEvents,
          signEvent,
        ]);

        const signed = await handoffRepo.signHandoff(
          client,
          handoffId,
          snapshot,
          actor,
        );
        if (!signed) {
          throw new Error("签收失败：交接包状态已变更");
        }

        await incidentRepo.createTimelineEvent(client, signEvent);

        const audit: Omit<AuditEvent, "id" | "created_at"> = {
          incident_id: existing.incident_id,
          handoff_id: handoffId,
          event_type: "handoff.signed",
          actor,
          payload: {
            handoff_id: handoffId,
            snapshot_captured_at: snapshot.captured_at,
            action_item_count: actionItems.length,
            timeline_event_count: timelineEvents.length + 1,
          },
        };
        await auditRepo.createAuditEvent(client, audit);

        eventBus.publish({
          type: "handoff.signed",
          incident_id: existing.incident_id,
          payload: { handoff_id: handoffId, signed_by: actor },
        });

        return signed;
      },
    );
    return result;
  });
}

export interface CreateAckInput {
  handoff_id: string;
  item_type: ItemType;
  item_id: string;
  acknowledged_by: string;
  note?: string;
}

export async function createAcknowledgement(
  input: CreateAckInput,
  idempotencyKey?: string,
): Promise<{ acknowledgement: Acknowledgement; replayed: boolean }> {
  if (
    !input.handoff_id ||
    !input.item_type ||
    !input.item_id ||
    !input.acknowledged_by
  ) {
    throw new ValidationError("缺少必需的确认字段");
  }
  return withTransaction(async (client) => {
    const handoff = await handoffRepo.getHandoff(client, input.handoff_id);
    if (!handoff) {
      throw new NotFoundError(`交接包 ${input.handoff_id} 不存在`);
    }

    const existing = await handoffRepo.findAcknowledgement(
      client,
      input.handoff_id,
      input.item_type,
      input.item_id,
      null,
    );
    if (existing) {
      return { acknowledgement: existing, replayed: true };
    }

    let ackedVersion: number | null = null;
    if (input.item_type === "action_item") {
      const { rows } = await client.query<{ version: number }>(
        `SELECT version FROM action_items WHERE id = $1`,
        [input.item_id],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`行动项 ${input.item_id} 不存在`);
      }
      ackedVersion = rows[0]!.version;
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM timeline_events WHERE id = $1`,
        [input.item_id],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`时间线事件 ${input.item_id} 不存在`);
      }
    }

    const { result, replayed: idemReplayed } = await withIdempotency(
      client,
      idempotencyKey,
      `ack:${input.handoff_id}:${input.item_type}:${input.item_id}`,
      async () => {
        const inserted = await handoffRepo.createAcknowledgement(client, {
          id: ids.acknowledgement(),
          handoff_id: input.handoff_id,
          item_type: input.item_type,
          item_id: input.item_id,
          acknowledged_by: input.acknowledged_by,
          note: input.note ?? "",
          supplemental_handoff_id: null,
          acked_version: ackedVersion,
        });
        if (!inserted) {
          const winner = await handoffRepo.findAcknowledgement(
            client,
            input.handoff_id,
            input.item_type,
            input.item_id,
            null,
          );
          return { ack: winner!, won: false };
        }
        await auditRepo.createAuditEvent(client, {
          incident_id: handoff.incident_id,
          handoff_id: input.handoff_id,
          event_type: "acknowledgement.created",
          actor: input.acknowledged_by,
          payload: {
            acknowledgement_id: inserted.id,
            item_type: input.item_type,
            item_id: input.item_id,
            acked_version: ackedVersion,
          },
        });
        eventBus.publish({
          type: "acknowledgement.created",
          incident_id: handoff.incident_id,
          payload: {
            handoff_id: input.handoff_id,
            item_type: input.item_type,
            item_id: input.item_id,
          },
        });
        return { ack: inserted, won: true };
      },
    );
    return {
      acknowledgement: result.ack,
      replayed: idemReplayed || !result.won,
    };
  });
}

export interface AppendSupplementalInput {
  handoff_id: string;
  kind: string;
  description: string;
  responsible_party: string;
  occurred_at?: string;
  actor: string;
}

export async function appendSupplementalEvent(
  input: AppendSupplementalInput,
  idempotencyKey?: string,
): Promise<SupplementalEvent> {
  return withTransaction(async (client) => {
    const handoff = await handoffRepo.getHandoff(client, input.handoff_id);
    if (!handoff) {
      throw new NotFoundError(`交接包 ${input.handoff_id} 不存在`);
    }
    if (handoff.status !== "signed") {
      throw new ImmutableResourceError("只能对已签收交接包追加补充事件");
    }
    const { result } = await withIdempotency(
      client,
      idempotencyKey,
      `supplemental:${input.handoff_id}:${input.kind}:${input.description}`,
      async () => {
        const se = await handoffRepo.createSupplementalEvent(client, {
          id: ids.supplementalEvent(),
          incident_id: handoff.incident_id,
          parent_handoff_id: input.handoff_id,
          kind: input.kind,
          description: input.description,
          responsible_party: input.responsible_party,
          occurred_at: input.occurred_at ?? new Date().toISOString(),
        });
        await auditRepo.createAuditEvent(client, {
          incident_id: handoff.incident_id,
          handoff_id: input.handoff_id,
          event_type: "supplemental_event.created",
          actor: input.actor,
          payload: { supplemental_event_id: se.id, kind: se.kind },
        });
        eventBus.publish({
          type: "supplemental_event.created",
          incident_id: handoff.incident_id,
          payload: {
            parent_handoff_id: input.handoff_id,
            supplemental_event_id: se.id,
          },
        });
        return se;
      },
    );
    return result;
  });
}

export interface CreateSupplementalHandoffInput {
  parent_handoff_id: string;
  actor: string;
  summary?: string;
}

export interface CreateSupplementalHandoffResult {
  supplemental_handoff: SupplementalHandoff;
  created: boolean;
}

const DIFF_FIELDS = [
  "title",
  "detail",
  "status",
  "responsible_party",
  "occurred_at",
] as const;

function computeDiff(
  parentHandoff: Handoff,
  currentActionItems: ActionItem[],
  currentTimeline: TimelineEvent[],
): SupplementalDiff {
  const snapshot = parentHandoff.snapshot;
  if (!snapshot) {
    throw new ImmutableResourceError("父交接包缺少快照，无法计算差异");
  }

  const baseActionItems = new Map(snapshot.action_items.map((a) => [a.id, a]));
  const baseTimelineIds = new Set(snapshot.timeline_events.map((t) => t.id));

  const added_action_items: ActionItem[] = [];
  const changed_action_items: ChangedActionItem[] = [];

  for (const current of currentActionItems) {
    const base = baseActionItems.get(current.id);
    if (!base) {
      added_action_items.push(current);
      continue;
    }
    const changes: ChangedActionItem["changes"] = {};
    for (const field of DIFF_FIELDS) {
      const baseValue = (base as unknown as Record<string, unknown>)[field];
      const currentValue = (current as unknown as Record<string, unknown>)[
        field
      ];
      if (JSON.stringify(baseValue) !== JSON.stringify(currentValue)) {
        changes[field] = { from: baseValue, to: currentValue };
      }
    }
    if (Object.keys(changes).length > 0) {
      changed_action_items.push({
        id: current.id,
        title: current.title,
        from_version: base.version,
        to_version: current.version,
        changes,
      });
    }
  }

  const added_timeline_events = currentTimeline.filter(
    (t) => !baseTimelineIds.has(t.id),
  );

  return {
    parent_handoff_id: parentHandoff.id,
    parent_signed_off_at:
      parentHandoff.signed_off_at ?? new Date().toISOString(),
    generated_at: new Date().toISOString(),
    added_action_items,
    changed_action_items,
    added_timeline_events,
  };
}

export async function createSupplementalHandoff(
  input: CreateSupplementalHandoffInput,
  idempotencyKey?: string,
): Promise<CreateSupplementalHandoffResult> {
  return withTransaction(async (client) => {
    const parent = await handoffRepo.getHandoffForUpdate(
      client,
      input.parent_handoff_id,
    );
    if (!parent) {
      throw new NotFoundError(`交接包 ${input.parent_handoff_id} 不存在`);
    }
    if (parent.status !== "signed") {
      throw new ImmutableResourceError("只能对已签收交接包创建补充交接包");
    }

    const existing = await handoffRepo.getSupplementalHandoffByParent(
      client,
      parent.id,
    );
    if (existing) {
      return { supplemental_handoff: existing, created: false };
    }

    const { result, replayed } = await withIdempotency(
      client,
      idempotencyKey,
      `supplemental_handoff:${parent.id}`,
      async () => {
        const [actionItems, timelineEvents] = await Promise.all([
          incidentRepo.listActionItems(client, parent.incident_id),
          incidentRepo.listTimelineEvents(client, parent.incident_id),
        ]);
        const diff = computeDiff(parent, actionItems, timelineEvents);

        const created = await handoffRepo.createSupplementalHandoff(client, {
          id: ids.supplementalHandoff(),
          incident_id: parent.incident_id,
          parent_handoff_id: parent.id,
          from_shift: parent.to_shift,
          to_shift: parent.from_shift,
          summary: input.summary ?? "签收后变化补充交接",
          diff,
          created_by: input.actor,
        });

        if (!created) {
          const winner = await handoffRepo.getSupplementalHandoffByParent(
            client,
            parent.id,
          );
          return { supplemental_handoff: winner!, created: false };
        }

        await auditRepo.createAuditEvent(client, {
          incident_id: parent.incident_id,
          handoff_id: parent.id,
          event_type: "supplemental_handoff.created",
          actor: input.actor,
          payload: {
            supplemental_handoff_id: created.id,
            parent_handoff_id: parent.id,
            added_action_item_count: diff.added_action_items.length,
            changed_action_item_count: diff.changed_action_items.length,
            added_timeline_event_count: diff.added_timeline_events.length,
          },
        });

        eventBus.publish({
          type: "supplemental_handoff.created",
          incident_id: parent.incident_id,
          payload: {
            supplemental_handoff_id: created.id,
            parent_handoff_id: parent.id,
          },
        });

        return { supplemental_handoff: created, created: true };
      },
    );

    return {
      supplemental_handoff: result.supplemental_handoff,
      created: result.created && !replayed,
    };
  });
}

export interface CreateSupplementalAckInput {
  supplemental_handoff_id: string;
  item_type: ItemType;
  item_id: string;
  acknowledged_by: string;
  note?: string;
  expected_version?: number;
}

const ACK_DIFF_FIELDS = [
  "title",
  "detail",
  "status",
  "responsible_party",
  "occurred_at",
] as const;

function itemInSupplementalDiff(
  diff: SupplementalDiff,
  itemType: ItemType,
  itemId: string,
): boolean {
  if (itemType === "action_item") {
    return (
      diff.added_action_items.some((a) => a.id === itemId) ||
      diff.changed_action_items.some((c) => c.id === itemId)
    );
  }
  return diff.added_timeline_events.some((t) => t.id === itemId);
}

function buildAckConflicts(
  base: ActionItem | null,
  current: ActionItem,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const field of ACK_DIFF_FIELDS) {
    const baseValue = base
      ? (base as unknown as Record<string, unknown>)[field]
      : null;
    const currentValue = (current as unknown as Record<string, unknown>)[field];
    if (!base || JSON.stringify(baseValue) !== JSON.stringify(currentValue)) {
      conflicts.push({
        field,
        base: baseValue,
        current: currentValue,
        attempted: baseValue,
      });
    }
  }
  return conflicts;
}

export async function createSupplementalAcknowledgement(
  input: CreateSupplementalAckInput,
  idempotencyKey?: string,
): Promise<{ acknowledgement: Acknowledgement; replayed: boolean }> {
  if (
    !input.supplemental_handoff_id ||
    !input.item_type ||
    !input.item_id ||
    !input.acknowledged_by
  ) {
    throw new ValidationError("缺少必需的补充包确认字段");
  }
  return withTransaction(async (client) => {
    const sh = await handoffRepo.getSupplementalHandoffById(
      client,
      input.supplemental_handoff_id,
    );
    if (!sh) {
      throw new NotFoundError(
        `补充交接包 ${input.supplemental_handoff_id} 不存在`,
      );
    }

    if (!itemInSupplementalDiff(sh.diff, input.item_type, input.item_id)) {
      throw new NotFoundError(
        `项目 ${input.item_id} 不在补充交接包 ${sh.id} 的差异清单中`,
      );
    }

    let ackedVersion: number | null = null;

    if (input.item_type === "action_item") {
      const current = await actionItemRepo.getActionItemForUpdate(
        client,
        input.item_id,
      );
      if (!current) {
        throw new NotFoundError(`行动项 ${input.item_id} 不存在`);
      }
      ackedVersion = current.version;

      if (
        input.expected_version !== undefined &&
        input.expected_version !== current.version
      ) {
        const base = await actionItemRepo.getRevision(
          client,
          input.item_id,
          input.expected_version,
        );
        const conflicts = buildAckConflicts(base, current);
        throw new OptimisticLockError(
          `行动项 ${input.item_id} 版本冲突：当前版本 ${current.version}，确认基于版本 ${input.expected_version}`,
          current.version,
          conflicts,
          current,
        );
      }
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM timeline_events WHERE id = $1`,
        [input.item_id],
      );
      if (rows.length === 0) {
        throw new NotFoundError(`时间线事件 ${input.item_id} 不存在`);
      }
    }

    const existing = await handoffRepo.findAcknowledgement(
      client,
      sh.parent_handoff_id,
      input.item_type,
      input.item_id,
      sh.id,
    );
    if (existing) {
      return { acknowledgement: existing, replayed: true };
    }

    const { result, replayed: idemReplayed } = await withIdempotency(
      client,
      idempotencyKey,
      `supplemental_ack:${sh.id}:${input.item_type}:${input.item_id}`,
      async () => {
        const inserted = await handoffRepo.createAcknowledgement(client, {
          id: ids.acknowledgement(),
          handoff_id: sh.parent_handoff_id,
          item_type: input.item_type,
          item_id: input.item_id,
          acknowledged_by: input.acknowledged_by,
          note: input.note ?? "",
          supplemental_handoff_id: sh.id,
          acked_version: ackedVersion,
        });
        if (!inserted) {
          const winner = await handoffRepo.findAcknowledgement(
            client,
            sh.parent_handoff_id,
            input.item_type,
            input.item_id,
            sh.id,
          );
          return { ack: winner!, won: false };
        }
        await auditRepo.createAuditEvent(client, {
          incident_id: sh.incident_id,
          handoff_id: sh.parent_handoff_id,
          event_type: "supplemental_acknowledgement.created",
          actor: input.acknowledged_by,
          payload: {
            acknowledgement_id: inserted.id,
            supplemental_handoff_id: sh.id,
            item_type: input.item_type,
            item_id: input.item_id,
            acked_version: ackedVersion,
          },
        });
        eventBus.publish({
          type: "supplemental_acknowledgement.created",
          incident_id: sh.incident_id,
          payload: {
            supplemental_handoff_id: sh.id,
            parent_handoff_id: sh.parent_handoff_id,
            item_type: input.item_type,
            item_id: input.item_id,
          },
        });
        return { ack: inserted, won: true };
      },
    );

    return {
      acknowledgement: result.ack,
      replayed: idemReplayed || !result.won,
    };
  });
}

export async function getHandoffDetail(
  handoffId: string,
): Promise<HandoffDetail> {
  const client = await pool.connect();
  try {
    const handoff = await handoffRepo.getHandoff(client, handoffId);
    if (!handoff) {
      throw new NotFoundError(`交接包 ${handoffId} 不存在`);
    }
    const allAcknowledgements = await handoffRepo.listAcknowledgements(
      client,
      handoffId,
    );
    const acknowledgements = allAcknowledgements.filter(
      (a) => a.supplemental_handoff_id === null,
    );
    const supplemental_acknowledgements = allAcknowledgements.filter(
      (a) => a.supplemental_handoff_id !== null,
    );
    const supplemental_events = await handoffRepo.listSupplementalEvents(
      client,
      handoffId,
    );
    const supplementalHandoffs = await handoffRepo.listSupplementalHandoffs(
      client,
      handoff.incident_id,
    );
    const supplemental_handoff =
      supplementalHandoffs.find((s) => s.parent_handoff_id === handoffId) ??
      null;
    return {
      handoff,
      acknowledgements,
      supplemental_acknowledgements,
      supplemental_events,
      supplemental_handoff,
    };
  } finally {
    client.release();
  }
}
