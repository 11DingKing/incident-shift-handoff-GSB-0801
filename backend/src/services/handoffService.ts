import type { PoolClient } from "pg";
import { withTransaction, pool } from "../db.js";
import type {
  Handoff,
  Acknowledgement,
  SupplementalEvent,
  ItemType,
  SnapshotData,
  ActionItem,
  TimelineEvent,
  AuditEvent,
} from "../types.js";
import {
  NotFoundError,
  ValidationError,
  ImmutableResourceError,
} from "../types.js";
import * as incidentRepo from "../repositories/incidentRepo.js";
import * as handoffRepo from "../repositories/handoffRepo.js";
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
  supplemental_events: SupplementalEvent[];
  supplemental_handoff: import("../types.js").SupplementalHandoff | null;
}

export async function createHandoff(
  input: CreateHandoffInput,
  idempotencyKey?: string
): Promise<Handoff> {
  if (!input.incident_id || !input.from_shift || !input.to_shift || !input.created_by) {
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
      }
    );
    return result;
  });
}

function buildSnapshot(
  incident: NonNullable<Awaited<ReturnType<typeof incidentRepo.getIncident>>>,
  actionItems: ActionItem[],
  timelineEvents: TimelineEvent[]
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
  idempotencyKey?: string
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
          existing.incident_id
        );
        if (!incident) {
          throw new NotFoundError(`事件 ${existing.incident_id} 不存在`);
        }
        const actionItems = await incidentRepo.listActionItems(
          client,
          existing.incident_id
        );
        const timelineEvents = await incidentRepo.listTimelineEvents(
          client,
          existing.incident_id
        );
        const snapshot = buildSnapshot(incident, actionItems, timelineEvents);

        const signed = await handoffRepo.signHandoff(
          client,
          handoffId,
          snapshot,
          actor
        );
        if (!signed) {
          throw new Error("签收失败：交接包状态已变更");
        }

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
            timeline_event_count: timelineEvents.length,
          },
        };
        await auditRepo.createAuditEvent(client, audit);

        eventBus.publish({
          type: "handoff.signed",
          incident_id: existing.incident_id,
          payload: { handoff_id: handoffId, signed_by: actor },
        });

        return signed;
      }
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
  idempotencyKey?: string
): Promise<{ acknowledgement: Acknowledgement; replayed: boolean }> {
  if (!input.handoff_id || !input.item_type || !input.item_id || !input.acknowledged_by) {
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
      null
    );
    if (existing) {
      return { acknowledgement: existing, replayed: true };
    }

    let ackedVersion: number | null = null;
    if (input.item_type === "action_item") {
      const { rows } = await client.query<{ version: number }>(
        `SELECT version FROM action_items WHERE id = $1`,
        [input.item_id]
      );
      if (rows.length === 0) {
        throw new NotFoundError(`行动项 ${input.item_id} 不存在`);
      }
      ackedVersion = rows[0]!.version;
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM timeline_events WHERE id = $1`,
        [input.item_id]
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
            null
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
      }
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
  idempotencyKey?: string
): Promise<SupplementalEvent> {
  return withTransaction(async (client) => {
    const handoff = await handoffRepo.getHandoff(client, input.handoff_id);
    if (!handoff) {
      throw new NotFoundError(`交接包 ${input.handoff_id} 不存在`);
    }
    if (handoff.status !== "signed") {
      throw new ImmutableResourceError(
        "只能对已签收交接包追加补充事件"
      );
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
      }
    );
    return result;
  });
}

export async function getHandoffDetail(
  handoffId: string
): Promise<HandoffDetail> {
  const client = await pool.connect();
  try {
    const handoff = await handoffRepo.getHandoff(client, handoffId);
    if (!handoff) {
      throw new NotFoundError(`交接包 ${handoffId} 不存在`);
    }
    const acknowledgements = await handoffRepo.listAcknowledgements(
      client,
      handoffId
    );
    const supplemental_events = await handoffRepo.listSupplementalEvents(
      client,
      handoffId
    );
    const supplementalHandoffs = await handoffRepo.listSupplementalHandoffs(
      client,
      handoff.incident_id
    );
    const supplemental_handoff =
      supplementalHandoffs.find((s) => s.parent_handoff_id === handoffId) ??
      null;
    return {
      handoff,
      acknowledgements,
      supplemental_events,
      supplemental_handoff,
    };
  } finally {
    client.release();
  }
}
