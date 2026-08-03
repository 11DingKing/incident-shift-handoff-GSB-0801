import type { PoolClient } from "pg";
import type { Incident, ActionItem, TimelineEvent, Handoff } from "../types.js";

export async function getIncident(
  client: PoolClient,
  id: string
): Promise<Incident | null> {
  const { rows } = await client.query<Incident>(
    `SELECT * FROM incidents WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listActionItems(
  client: PoolClient,
  incidentId: string
): Promise<ActionItem[]> {
  const { rows } = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE incident_id = $1 ORDER BY occurred_at ASC, id ASC`,
    [incidentId]
  );
  return rows;
}

export async function listTimelineEvents(
  client: PoolClient,
  incidentId: string
): Promise<TimelineEvent[]> {
  const { rows } = await client.query<TimelineEvent>(
    `SELECT * FROM timeline_events
     WHERE incident_id = $1
     ORDER BY occurred_at ASC, recorded_at ASC, id ASC`,
    [incidentId]
  );
  return rows;
}

export async function createActionItem(
  client: PoolClient,
  item: Omit<ActionItem, "created_at" | "updated_at" | "version"> &
    Partial<Pick<ActionItem, "version">>
): Promise<{ item: ActionItem; created: boolean }> {
  const { rows } = await client.query<ActionItem>(
    `INSERT INTO action_items
       (id, incident_id, title, detail, status, responsible_party, occurred_at, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      item.id,
      item.incident_id,
      item.title,
      item.detail,
      item.status,
      item.responsible_party,
      item.occurred_at,
      item.version ?? 1,
    ]
  );
  if (rows[0]) return { item: rows[0], created: true };
  const existing = await client.query<ActionItem>(
    `SELECT * FROM action_items WHERE id = $1`,
    [item.id]
  );
  return { item: existing.rows[0]!, created: false };
}

export async function createTimelineEvent(
  client: PoolClient,
  event: TimelineEvent
): Promise<TimelineEvent> {
  const { rows } = await client.query<TimelineEvent>(
    `INSERT INTO timeline_events
       (id, incident_id, kind, description, responsible_party, evidence_uri, occurred_at, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      event.id,
      event.incident_id,
      event.kind,
      event.description,
      event.responsible_party,
      event.evidence_uri,
      event.occurred_at,
      event.recorded_at,
    ]
  );
  if (rows[0]) return rows[0];
  const existing = await client.query<TimelineEvent>(
    `SELECT * FROM timeline_events WHERE id = $1`,
    [event.id]
  );
  return existing.rows[0]!;
}

export async function listHandoffs(
  client: PoolClient,
  incidentId: string
): Promise<Handoff[]> {
  const { rows } = await client.query<Handoff>(
    `SELECT * FROM handoffs WHERE incident_id = $1 ORDER BY created_at ASC, id ASC`,
    [incidentId]
  );
  return rows;
}
