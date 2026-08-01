import { withTransaction, pool } from "../db.js";
import type {
  Incident,
  ActionItem,
  TimelineEvent,
  Handoff,
  AuditEvent,
} from "../types.js";
import { NotFoundError, ValidationError } from "../types.js";
import * as incidentRepo from "../repositories/incidentRepo.js";
import * as handoffRepo from "../repositories/handoffRepo.js";
import * as auditRepo from "../repositories/auditRepo.js";
import { ids } from "../ids.js";
import { eventBus } from "./eventBus.js";
import { withIdempotency } from "./idempotency.js";

export interface IncidentDetail {
  incident: Incident;
  action_items: ActionItem[];
  timeline_events: TimelineEvent[];
  handoffs: Handoff[];
}

export async function getIncidentDetail(
  incidentId: string
): Promise<IncidentDetail> {
  const client = await pool.connect();
  try {
    const incident = await incidentRepo.getIncident(client, incidentId);
    if (!incident) {
      throw new NotFoundError(`事件 ${incidentId} 不存在`);
    }
    const action_items = await incidentRepo.listActionItems(
      client,
      incidentId
    );
    const timeline_events = await incidentRepo.listTimelineEvents(
      client,
      incidentId
    );
    const handoffs = await incidentRepo.listHandoffs(client, incidentId);
    return { incident, action_items, timeline_events, handoffs };
  } finally {
    client.release();
  }
}

export interface CreateTimelineInput {
  incident_id: string;
  kind: string;
  description: string;
  responsible_party: string;
  evidence_uri?: string;
  occurred_at?: string;
  actor: string;
}

export async function createTimelineEvent(
  input: CreateTimelineInput,
  idempotencyKey?: string
): Promise<TimelineEvent> {
  if (!input.kind || !input.description || !input.responsible_party) {
    throw new ValidationError("缺少时间线事件必需字段");
  }
  const occurredAt = input.occurred_at
    ? new Date(input.occurred_at).toISOString()
    : new Date().toISOString();

  return withTransaction(async (client) => {
    const incident = await incidentRepo.getIncident(client, input.incident_id);
    if (!incident) {
      throw new NotFoundError(`事件 ${input.incident_id} 不存在`);
    }

    const { result } = await withIdempotency(
      client,
      idempotencyKey,
      `timeline:${input.incident_id}:${input.kind}:${input.description}`,
      async () => {
        const event: TimelineEvent = {
          id: ids.timelineEvent(),
          incident_id: input.incident_id,
          kind: input.kind,
          description: input.description,
          responsible_party: input.responsible_party,
          evidence_uri: input.evidence_uri ?? null,
          occurred_at: occurredAt,
          recorded_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        await incidentRepo.createTimelineEvent(client, event);

        const { rows } = await client.query<{
          id: string;
          from_shift: string;
          to_shift: string;
        }>(
          `SELECT id, from_shift, to_shift FROM handoffs
           WHERE incident_id = $1 AND status = 'signed'
           ORDER BY signed_off_at DESC, created_at DESC LIMIT 1`,
          [input.incident_id]
        );
        const signed = rows[0];
        if (signed) {
          await handoffRepo.createSupplementalEvent(client, {
            id: ids.supplementalEvent(),
            incident_id: input.incident_id,
            parent_handoff_id: signed.id,
            kind: input.kind,
            description: input.description,
            responsible_party: input.responsible_party,
            occurred_at: occurredAt,
          });
        }

        const audit: Omit<AuditEvent, "id" | "created_at"> = {
          incident_id: input.incident_id,
          handoff_id: signed?.id ?? null,
          event_type: "timeline.created",
          actor: input.actor,
          payload: {
            timeline_event_id: event.id,
            kind: event.kind,
            supplemental: Boolean(signed),
          },
        };
        await auditRepo.createAuditEvent(client, audit);

        eventBus.publish({
          type: "timeline.created",
          incident_id: input.incident_id,
          payload: { timeline_event_id: event.id, kind: event.kind },
        });
        return event;
      }
    );
    return result;
  });
}

export async function listAuditForIncident(
  incidentId: string,
  limit = 200
) {
  const client = await pool.connect();
  try {
    return auditRepo.listAuditEvents(client, { incidentId, limit });
  } finally {
    client.release();
  }
}
